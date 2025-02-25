import _ from 'lodash';
import path from 'path';
import url from 'url';
import logger from './logger';
import {tempDir, fs, util, zip, timing, node} from '@appium/support';
import { LRUCache } from 'lru-cache';
import AsyncLock from 'async-lock';
import axios from 'axios';
import B from 'bluebird';
import { getLocalAppsFolder, getSharedFolderForAppUrl, getLocalFileForAppUrl, getFileContentLength } from './mcloud-utils';
// @ts-ignore
import { stat } from 'fs';

// for compat with running tests transpiled and in-place
const {version: BASEDRIVER_VER} = fs.readPackageJsonFrom(__dirname);
const IPA_EXT = '.ipa';
const ZIP_EXTS = new Set(['.zip', IPA_EXT]);
const ZIP_MIME_TYPES = ['application/zip', 'application/x-zip-compressed', 'multipart/x-zip'];
const CACHED_APPS_MAX_AGE = 1000 * 60 * 60 * 24; // ms
const MAX_CACHED_APPS = 1024;
const HTTP_STATUS_NOT_MODIFIED = 304;
const DEFAULT_REQ_HEADERS = Object.freeze({
  'user-agent': `Appium (BaseDriver v${BASEDRIVER_VER})`,
});
const AVG_DOWNLOAD_SPEED_MEASUREMENT_THRESHOLD_SEC = 2;
const APPLICATIONS_CACHE = new LRUCache({
  max: MAX_CACHED_APPS,
  ttl: CACHED_APPS_MAX_AGE, // expire after 24 hours
  updateAgeOnGet: true,
  // @ts-ignore The fullPath property exists
  dispose: ({fullPath}, app) => {
    logger.info(
      `The application '${app}' cached at '${fullPath}' has ` +
        `expired after ${CACHED_APPS_MAX_AGE}ms`
    );
    if (fullPath) {
      logger.info(`[MCLOUD] APPLICATIONS_CACHE setting. Deleting files by path: ${fullPath}`);
      fs.rimraf(fullPath);
    }
  },
  noDisposeOnSet: true,
});
const APPLICATIONS_CACHE_GUARD = new AsyncLock();
const SANITIZE_REPLACEMENT = '-';
const DEFAULT_BASENAME = 'appium-app';
const APP_DOWNLOAD_TIMEOUT_MS = 120 * 1000;

process.on('exit', () => {
  if (APPLICATIONS_CACHE.size === 0) {
    return;
  }

  const appPaths = [...APPLICATIONS_CACHE.values()]
    // @ts-ignore The fullPath property exists
    .map(({fullPath}) => fullPath);
  logger.debug(
    `Performing cleanup of ${appPaths.length} cached ` +
      util.pluralize('application', appPaths.length)
  );
  for (const appPath of appPaths) {
    try {
      // Asynchronous calls are not supported in onExit handler
      logger.info(`[MCLOUD] process.on('exit'). Deleting files by path: ${appPath}`);
      fs.rimrafSync(appPath);
    } catch (e) {
      logger.warn(e.message);
    }
  }
});

function verifyAppExtension(app, supportedAppExtensions) {
  if (supportedAppExtensions.map(_.toLower).includes(_.toLower(path.extname(app)))) {
    return app;
  }
  throw new Error(
    `New app path '${app}' did not have ` +
      `${util.pluralize('extension', supportedAppExtensions.length, false)}: ` +
      supportedAppExtensions
  );
}

async function calculateFolderIntegrity(folderPath) {
  return (await fs.glob('**/*', {cwd: folderPath})).length;
}

async function calculateFileIntegrity(filePath) {
  return await fs.hash(filePath);
}

async function isAppIntegrityOk(currentPath, expectedIntegrity = {}) {
  if (!(await fs.exists(currentPath))) {
    return false;
  }

  // Folder integrity check is simple:
  // Verify the previous amount of files is not greater than the current one.
  // We don't want to use equality comparison because of an assumption that the OS might
  // create some unwanted service files/cached inside of that folder or its subfolders.
  // Ofc, validating the hash sum of each file (or at least of file path) would be much
  // more precise, but we don't need to be very precise here and also don't want to
  // overuse RAM and have a performance drop.
  return (await fs.stat(currentPath)).isDirectory()
    ? (await calculateFolderIntegrity(currentPath)) >= expectedIntegrity?.folder
    : (await calculateFileIntegrity(currentPath)) === expectedIntegrity?.file;
}

/**
 *
 * @param {string} app
 * @param {string|string[]|import('@appium/types').ConfigureAppOptions} options
 */
async function configureApp(
  app,
  options = /** @type {import('@appium/types').ConfigureAppOptions} */ ({})
) {
  if (!_.isString(app)) {
    // immediately shortcircuit if not given an app
    return;
  }

  let supportedAppExtensions;
  const onPostProcess =
    !_.isString(options) && !_.isArray(options) ? options.onPostProcess : undefined;

  if (_.isString(options)) {
    supportedAppExtensions = [options];
  } else if (_.isArray(options)) {
    supportedAppExtensions = options;
  } else if (_.isPlainObject(options)) {
    supportedAppExtensions = options.supportedExtensions;
  }
  if (_.isEmpty(supportedAppExtensions)) {
    throw new Error(`One or more supported app extensions must be provided`);
  }

  let newApp = app;
  let shouldUnzipApp = false;
  let packageHash = null;
  let localAppsFolder;
  /** @type {import('axios').AxiosResponse['headers']|undefined} */
  let headers = undefined;
  /** @type {RemoteAppProps} */
  const remoteAppProps = {
    lastModified: null,
    immutable: false,
    maxAge: null,
    etag: null,
  };
  const {protocol, pathname} = url.parse(newApp);
  const isUrl = protocol === null ? false : ['http:', 'https:'].includes(protocol);

  /** @type {import('@appium/types').CachedAppInfo|undefined} */
  // @ts-ignore We know the returned type
  const cachedAppInfo = APPLICATIONS_CACHE.get(app);
  if (cachedAppInfo) {
    logger.debug(`Cached app data: ${JSON.stringify(cachedAppInfo, null, 2)}`);
  }

  return await APPLICATIONS_CACHE_GUARD.acquire(app, async () => {
    if (isUrl) {
      // Use the app from remote URL
      logger.info(`Using downloadable app '${newApp}'`);
      const reqHeaders = {
        ...DEFAULT_REQ_HEADERS,
      };
      if (cachedAppInfo?.etag) {
        reqHeaders['if-none-match'] = cachedAppInfo.etag;
      } else if (cachedAppInfo?.lastModified) {
        reqHeaders['if-modified-since'] = cachedAppInfo.lastModified.toUTCString();
      }

      let {headers, stream, status} = await queryAppLink(newApp, reqHeaders);
      try {
        if (!_.isEmpty(headers)) {
          logger.debug(`Etag: ${headers.etag}`);
          if (headers.etag) {
            remoteAppProps.etag = headers.etag;
          }
          logger.debug(`Last-Modified: ${headers['last-modified']}`);
          if (headers['last-modified']) {
            remoteAppProps.lastModified = new Date(headers['last-modified']);
          }
          logger.debug(`Cache-Control: ${headers['cache-control']}`);
          if (headers['cache-control']) {
            remoteAppProps.immutable = /\bimmutable\b/i.test(headers['cache-control']);
            const maxAgeMatch = /\bmax-age=(\d+)\b/i.exec(headers['cache-control']);
            if (maxAgeMatch) {
              remoteAppProps.maxAge = parseInt(maxAgeMatch[1], 10);
            }
          }
        }

        // ***** Custom logic for verification of local static path for APPs *****
        let downloadIsNeaded = true;
        localAppsFolder = await getLocalAppsFolder();
        let localFile;
        let lockFile = '';
        const waitingTime = 1000;
        const maxAttemptsCount = Number(process.env.APPIUM_APP_WAITING_TIMEOUT);
        const maxLockFileLifetime = Number(process.env.APPIUM_MAX_LOCK_FILE_LIFETIME);
        const appSizeCheckDisabled = Boolean(process.env.APPIUM_APP_SIZE_DISABLE?.toLowerCase?.() === 'true');
        let appFetchRetries = Number(process.env.APPIUM_APP_FETCH_RETRIES);

        if(localAppsFolder != undefined) {
          localFile = await getLocalFileForAppUrl(newApp);
          lockFile = localFile + '.lock';

          if(await fs.exists(localFile)) {
            if(appSizeCheckDisabled === false) {
              // Checking of local application actuality
              logger.info(`[MCLOUD] Local version of app was found. Will check actuality of the file`);
              // At this point local file might be deleted by parallel session which updates outdated app
              let attemptsCount = 0;
              while(!await fs.exists(localFile) && (attemptsCount++ < maxAttemptsCount)) {
                await new Promise((resolve) => {
                  logger.info(`[MCLOUD] Attempt #${attemptsCount} for local app file to appear again`);
                  setTimeout(resolve, waitingTime);
                });
              }
              if(!await fs.exists(localFile)) {
                throw Error(`[MCLOUD] Local application file has not appeared after updating by parallel Appium session`);
              }
              const stats = await fs.stat(localFile);
              const localFileLength = stats.size;
              const remoteFileLength = await getFileContentLength(app);
              logger.info(`[MCLOUD] Remote file size is ${remoteFileLength} and local file size is ${localFileLength}`);
              if(remoteFileLength != localFileLength) {
                logger.info(`[MCLOUD] Sizes differ. Hence that's needed to download fresh version of the app`);
                if (await fs.exists(localFile)) {
                  await fs.unlink(localFile);
                } else {
                  logger.warn(`[MCLOUD] Old local application file ${localFile} was not found. Probably it was removed by another thread which was downloading app in parallel`);
                }
                downloadIsNeaded = true;
              } else {
                logger.info(`[MCLOUD] Sizes are the same. Hence will use already stored application for the session`);
                newApp = localFile;
                shouldUnzipApp = ZIP_EXTS.has(path.extname(newApp));
                downloadIsNeaded = false;
              }
            } else {
              logger.info(`[MCLOUD] APPIUM_APP_SIZE_DISABLE=true hence skipping file size checking and going to use found file as application source`);
              newApp = localFile;
              shouldUnzipApp = ZIP_EXTS.has(path.extname(newApp));
              downloadIsNeaded = false;
            }
          } else if (await fs.exists(lockFile)) {
            logger.info(`[MCLOUD] Local version of app not found but .lock file exists. Waiting for .lock to disappear`);
            logger.info(`[MCLOUD] .lock file parameters. Сreated time: ${(await fs.stat(lockFile)).ctime.toLocaleString('en-US', { timeZoneName: 'short' })}; device/session details: ${await fs.readFile(lockFile, 'utf8')}`);
            // Wait for some time till App is downloaded by some parallel Appium instance
            let attemptsCount = 0;
            while(await fs.exists(lockFile) && (attemptsCount++ < maxAttemptsCount)) {
              const stats = await fs.stat(lockFile);
              var diffInSeconds = (new Date().getTime() - stats.ctime.getTime()) / 1000;

              if (diffInSeconds >= maxLockFileLifetime) {
                logger.info(`[MCLOUD] Removing .lock file since its lifetime reached to the limit`);
                if (await fs.exists(lockFile)) {
                  await fs.unlink(lockFile);
                  throw Error(`[MCLOUD] .lock file was removed due to lifetime limit. New download attempt will start for the next session request`);
                } else {
                  logger.warn(`[MCLOUD] Lock file ${lockFile} was not found. Probably it was removed by another thread which was downloading app in parallel`);
                }
              }

              await new Promise((resolve) => {
                logger.info(`[MCLOUD] Attempt #${attemptsCount} for .lock file checking`);
                setTimeout(resolve, waitingTime);
              });
            }
            if(await fs.exists(lockFile)) {
              throw Error(`[MCLOUD] .lock file for downloading application has not disappeared after ${waitingTime * maxAttemptsCount}ms`);
            }
            if(!await fs.exists(localFile)) {
              throw Error(`[MCLOUD] Local application file has not appeared after .lock file removal`);
            }
            logger.info(`[MCLOUD] Local version of app was found after .lock file removal. Will use it for new session`);
            newApp = localFile;
            shouldUnzipApp = ZIP_EXTS.has(path.extname(newApp));
            downloadIsNeaded = false;
          } else {
            logger.info(`[MCLOUD] Neither local version of app nor .lock file was found. Will download app from remote URL.`);
            downloadIsNeaded = true;
          }
        } else {
          logger.info(`[MCLOUD] Local apps folder is not defined via environment properties, hence skipping this logic. Use variable APPIUM_APPS_DIR for path setting`);
        }
        if(downloadIsNeaded) {

          if(localAppsFolder != undefined) {
            logger.info(`[MCLOUD] Local version of app was not found. Hence using default Appium logic for downloading`);
            const sharedFolderPath = await getSharedFolderForAppUrl(app);
            logger.info(`[MCLOUD] Folder for local shared apps: ${sharedFolderPath}`);
            // @ts-ignore
            await fs.close(await fs.open(lockFile, 'w'));
            var sessionId = process.env.sessionId;
            var deviceId = process.env.DEVICE_UDID;
            if(sessionId === undefined) {
              sessionId = "could not define session ID";
            }
            if(deviceId === undefined) {
              deviceId = "could not define device UUID";
            }
            var msg = `device UUID: ${deviceId}, session ID: ${sessionId}`;
            logger.info(`[MCLOUD] session/device info: ${msg}`);
            await fs.writeFile(lockFile, msg);
            logger.info(`[MCLOUD] lock file was written successfully`);
          }
        }

        try {

        if (cachedAppInfo && status === HTTP_STATUS_NOT_MODIFIED) {
          if (await isAppIntegrityOk(cachedAppInfo.fullPath, cachedAppInfo.integrity)) {
            logger.info(`Reusing previously downloaded application at '${cachedAppInfo.fullPath}'`);
            return verifyAppExtension(cachedAppInfo.fullPath, supportedAppExtensions);
          }
          logger.info(
            `The application at '${cachedAppInfo.fullPath}' does not exist anymore ` +
              `or its integrity has been damaged. Deleting it from the internal cache`
          );
          APPLICATIONS_CACHE.delete(app);

          if (!stream.closed) {
            stream.destroy();
          }
          ({stream, headers, status} = await queryAppLink(newApp, {...DEFAULT_REQ_HEADERS}));
        }

        let fileName = null;
        const basename = fs.sanitizeName(path.basename(decodeURIComponent(pathname ?? '')), {
          replacement: SANITIZE_REPLACEMENT,
        });
        const extname = path.extname(basename);
        // to determine if we need to unzip the app, we have a number of places
        // to look: content type, content disposition, or the file extension
        if (ZIP_EXTS.has(extname)) {
          fileName = basename;
          shouldUnzipApp = true;
        }
        if (headers['content-type']) {
          const ct = headers['content-type'];
          logger.debug(`Content-Type: ${ct}`);
          // the filetype may not be obvious for certain urls, so check the mime type too
          if (
            ZIP_MIME_TYPES.some((mimeType) =>
              new RegExp(`\\b${_.escapeRegExp(mimeType)}\\b`).test(ct)
            )
          ) {
            if (!fileName) {
              fileName = `${DEFAULT_BASENAME}.zip`;
            }
            shouldUnzipApp = true;
          }
        }
        if (headers['content-disposition'] && /^attachment/i.test(headers['content-disposition'])) {
          logger.debug(`Content-Disposition: ${headers['content-disposition']}`);
          const match = /filename="([^"]+)/i.exec(headers['content-disposition']);
          if (match) {
            fileName = fs.sanitizeName(match[1], {
              replacement: SANITIZE_REPLACEMENT,
            });
            shouldUnzipApp = shouldUnzipApp || ZIP_EXTS.has(path.extname(fileName));
          }
        }
        if (!fileName) {
          // assign the default file name and the extension if none has been detected
          const resultingName = basename
            ? basename.substring(0, basename.length - extname.length)
            : DEFAULT_BASENAME;
          let resultingExt = extname;
          if (!supportedAppExtensions.includes(resultingExt)) {
            logger.info(
              `The current file extension '${resultingExt}' is not supported. ` +
                `Defaulting to '${_.first(supportedAppExtensions)}'`
            );
            resultingExt = /** @type {string} */ (_.first(supportedAppExtensions));
          }
          fileName = `${resultingName}${resultingExt}`;
        }
        const targetPath = await tempDir.path({
          prefix: fileName,
          suffix: '',
        });

        // newApp = await fetchApp(stream, stargetPath);
        while(appFetchRetries-- >= 0 && !(await fs.exists(newApp)))
        {
          try {
            logger.info(`[MCLOUD] Going to fetch remote app`);
            newApp = await fetchApp(stream, targetPath);
          } catch (err) {
            logger.error(`[MCLOUD] Error during fetching of the application ${err.message}. Attempts left ${appFetchRetries}`);
          }
        }
              
        // ***** Custom logic for copying of downloaded app to static location *****
        if(localAppsFolder != undefined) {
          logger.info(`[MCLOUD] New app path: ${newApp}`);
          // @ts-ignore
          await fs.copyFile(newApp, localFile);
        }
        }
        finally {
          if(localAppsFolder != undefined) {
            logger.info(`[MCLOUD] Going to remove lock file ${lockFile}`)
            // @ts-ignore
            if (await fs.exists(lockFile)) {
              // @ts-ignore
              await fs.unlink(lockFile);
            } else {
              logger.warn(`[MCLOUD] Lock file ${lockFile} was not found. Probably it was removed by another thread which was downloading app in parallel`);
            }
          }
        }

      } finally {
        if (!stream.closed) {
          stream.destroy();
        }
      }
    } else if (await fs.exists(newApp)) {
      // Use the local app
      logger.info(`Using local app '${newApp}'`);
      shouldUnzipApp = ZIP_EXTS.has(path.extname(newApp));
    } else {
      let errorMessage = `The application at '${newApp}' does not exist or is not accessible`;
      // protocol value for 'C:\\temp' is 'c:', so we check the length as well
      if (_.isString(protocol) && protocol.length > 2) {
        errorMessage =
          `The protocol '${protocol}' used in '${newApp}' is not supported. ` +
          `Only http: and https: protocols are supported`;
      }
      throw new Error(errorMessage);
    }

    const isPackageAFile = (await fs.stat(newApp)).isFile();
    if (isPackageAFile) {
      packageHash = await calculateFileIntegrity(newApp);
    }

    if (isPackageAFile && shouldUnzipApp && !_.isFunction(onPostProcess)) {
      const archivePath = newApp;
      if (packageHash === cachedAppInfo?.packageHash) {
        const fullPath = cachedAppInfo?.fullPath;
        if (await isAppIntegrityOk(fullPath, cachedAppInfo?.integrity)) {
          // if (archivePath !== app) {
          if (archivePath !== app && localAppsFolder === undefined) {
            logger.info(`[MCLOUD] isAppIntegrityOk=true. Deleting files by path: ${archivePath}`);
            await fs.rimraf(archivePath);
          }
          logger.info(`Will reuse previously cached application at '${fullPath}'`);
          return verifyAppExtension(fullPath, supportedAppExtensions);
        }
        logger.info(
          `The application at '${fullPath}' does not exist anymore ` +
            `or its integrity has been damaged. Deleting it from the cache`
        );
        APPLICATIONS_CACHE.delete(app);
      }
      const tmpRoot = await tempDir.openDir();
      try {
        newApp = await unzipApp(archivePath, tmpRoot, supportedAppExtensions);
      } finally {
        // if (newApp !== archivePath && archivePath !== app) {
        if (newApp !== archivePath && archivePath !== app && localAppsFolder === undefined) {
          logger.info(`[MCLOUD] Remove after unzipApp(). Deleting files by path: ${archivePath}`);
          await fs.rimraf(archivePath);
        }
      }
      logger.info(`Unzipped local app to '${newApp}'`);
    } else if (!path.isAbsolute(newApp)) {
      newApp = path.resolve(process.cwd(), newApp);
      logger.warn(
        `The current application path '${app}' is not absolute ` +
          `and has been rewritten to '${newApp}'. Consider using absolute paths rather than relative`
      );
      app = newApp;
    }

    const storeAppInCache = async (appPathToCache) => {
      const cachedFullPath = cachedAppInfo?.fullPath;
      // if (cachedFullPath && cachedFullPath !== appPathToCache) {
      // [MCLOUD] We control actuality of the file in custom logic.
      // so no need to remove file phisically from shared location when updating Appium cache.
      if (cachedFullPath && cachedFullPath !== appPathToCache && localAppsFolder === undefined) {
        logger.info(`[MCLOUD] storeAppInCache(). Deleting files by path: ${cachedFullPath}`);
        await fs.rimraf(cachedFullPath);
      }
      const integrity = {};
      if ((await fs.stat(appPathToCache)).isDirectory()) {
        integrity.folder = await calculateFolderIntegrity(appPathToCache);
      } else {
        integrity.file = await calculateFileIntegrity(appPathToCache);
      }
      APPLICATIONS_CACHE.set(app, {
        ...remoteAppProps,
        timestamp: Date.now(),
        packageHash,
        integrity,
        fullPath: appPathToCache,
      });
      return appPathToCache;
    };

    if (_.isFunction(onPostProcess)) {
      const result = await onPostProcess(
        /** @type {import('@appium/types').PostProcessOptions<import('axios').AxiosResponseHeaders>} */ ({
          cachedAppInfo: _.clone(cachedAppInfo),
          isUrl,
          headers: _.clone(headers),
          appPath: newApp,
        })
      );
      return !result?.appPath || app === result?.appPath || !(await fs.exists(result?.appPath))
        ? newApp
        : await storeAppInCache(result.appPath);
    }

    verifyAppExtension(newApp, supportedAppExtensions);
    return app !== newApp && (packageHash || _.values(remoteAppProps).some(Boolean))
      ? await storeAppInCache(newApp)
      : newApp;
  });
}

/**
 * Sends a HTTP GET query to fetch the app with caching enabled.
 * Follows https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching
 *
 * @param {string} appLink The URL to download an app from
 * @param {import('axios').RawAxiosRequestHeaders} reqHeaders Additional HTTP request headers
 * @returns {Promise<RemoteAppData>}
 */
async function queryAppLink(appLink, reqHeaders) {
  const {href, auth} = url.parse(appLink);
  const axiosUrl = auth ? href.replace(`${auth}@`, '') : href;
  /** @type {import('axios').AxiosBasicCredentials|undefined} */
  const axiosAuth = auth ? {
    username: auth.substring(0, auth.indexOf(':')),
    password: auth.substring(auth.indexOf(':') + 1),
  } : undefined;
  /**
   * @type {import('axios').RawAxiosRequestConfig}
   */
  const requestOpts = {
    url: axiosUrl,
    auth: axiosAuth,
    responseType: 'stream',
    timeout: APP_DOWNLOAD_TIMEOUT_MS,
    validateStatus: (status) =>
      (status >= 200 && status < 300) || status === HTTP_STATUS_NOT_MODIFIED,
    headers: reqHeaders,
  };
  try {
    const {data: stream, headers, status} = await axios(requestOpts);
    return {
      stream,
      headers,
      status,
    };
  } catch (err) {
    throw new Error(`Cannot download the app from ${axiosUrl}: ${err.message}`);
  }
}

/**
 * Retrieves app payload from the given stream. Also meters the download performance.
 *
 * @param {import('stream').Readable} srcStream The incoming stream
 * @param {string} dstPath The target file path to be written
 * @returns {Promise<string>} The same dstPath
 * @throws {Error} If there was a failure while downloading the file
 */
async function fetchApp(srcStream, dstPath) {
  const timer = new timing.Timer().start();
  try {
    const writer = fs.createWriteStream(dstPath);
    srcStream.pipe(writer);

    await new B((resolve, reject) => {
      srcStream.once('error', reject);
      writer.once('finish', resolve);
      writer.once('error', (e) => {
        srcStream.unpipe(writer);
        reject(e);
      });
    });
  } catch (err) {
    throw new Error(`Cannot fetch the application: ${err.message}`);
  }

  const secondsElapsed = timer.getDuration().asSeconds;
  const {size} = await fs.stat(dstPath);
  logger.debug(
    `The application (${util.toReadableSizeString(size)}) ` +
      `has been downloaded to '${dstPath}' in ${secondsElapsed.toFixed(3)}s`
  );
  // it does not make much sense to approximate the speed for short downloads
  if (secondsElapsed >= AVG_DOWNLOAD_SPEED_MEASUREMENT_THRESHOLD_SEC) {
    const bytesPerSec = Math.floor(size / secondsElapsed);
    logger.debug(`Approximate download speed: ${util.toReadableSizeString(bytesPerSec)}/s`);
  }

  return dstPath;
}

/**
 * Extracts the bundle from an archive into the given folder
 *
 * @param {string} zipPath Full path to the archive containing the bundle
 * @param {string} dstRoot Full path to the folder where the extracted bundle
 * should be placed
 * @param {Array<string>|string} supportedAppExtensions The list of extensions
 * the target application bundle supports, for example ['.apk', '.apks'] for
 * Android packages
 * @returns {Promise<string>} Full path to the bundle in the destination folder
 * @throws {Error} If the given archive is invalid or no application bundles
 * have been found inside
 */
async function unzipApp(zipPath, dstRoot, supportedAppExtensions) {
  await zip.assertValidZip(zipPath);

  if (!_.isArray(supportedAppExtensions)) {
    supportedAppExtensions = [supportedAppExtensions];
  }

  const tmpRoot = await tempDir.openDir();
  try {
    logger.debug(`Unzipping '${zipPath}'`);
    const timer = new timing.Timer().start();
    const useSystemUnzipEnv = process.env.APPIUM_PREFER_SYSTEM_UNZIP;
    const useSystemUnzip =
      _.isEmpty(useSystemUnzipEnv) || !['0', 'false'].includes(_.toLower(useSystemUnzipEnv));
    /**
     * Attempt to use use the system `unzip` (e.g., `/usr/bin/unzip`) due
     * to the significant performance improvement it provides over the native
     * JS "unzip" implementation.
     * @type {import('@appium/support/lib/zip').ExtractAllOptions}
     */
    const extractionOpts = {useSystemUnzip};
    // https://github.com/appium/appium/issues/14100
    if (path.extname(zipPath) === IPA_EXT) {
      logger.debug(
        `Enforcing UTF-8 encoding on the extracted file names for '${path.basename(zipPath)}'`
      );
      extractionOpts.fileNamesEncoding = 'utf8';
    }
    await zip.extractAllTo(zipPath, tmpRoot, extractionOpts);
    const globPattern = `**/*.+(${supportedAppExtensions
      .map((ext) => ext.replace(/^\./, ''))
      .join('|')})`;
    const sortedBundleItems = (
      await fs.glob(globPattern, {
        cwd: tmpRoot,
        // Get the top level match
      })
    ).sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
    if (_.isEmpty(sortedBundleItems)) {
      throw logger.errorWithException(
        `App unzipped OK, but we could not find any '${supportedAppExtensions}' ` +
          util.pluralize('bundle', supportedAppExtensions.length, false) +
          ` in it. Make sure your archive contains at least one package having ` +
          `'${supportedAppExtensions}' ${util.pluralize(
            'extension',
            supportedAppExtensions.length,
            false
          )}`
      );
    }
    logger.debug(
      `Extracted ${util.pluralize('bundle item', sortedBundleItems.length, true)} ` +
        `from '${zipPath}' in ${Math.round(
          timer.getDuration().asMilliSeconds
        )}ms: ${sortedBundleItems}`
    );
    const matchedBundle = /** @type {string} */ (_.first(sortedBundleItems));
    logger.info(`Assuming '${matchedBundle}' is the correct bundle`);
    const dstPath = path.resolve(dstRoot, path.basename(matchedBundle));
    await fs.mv(path.resolve(tmpRoot, matchedBundle), dstPath, {mkdirp: true});
    return dstPath;
  } finally {
    logger.info(`[MCLOUD] unzipApp(). Deleting files by path: ${tmpRoot}`);
    await fs.rimraf(tmpRoot);
  }
}

function isPackageOrBundle(app) {
  return /^([a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+)+$/.test(app);
}

/**
 * Finds all instances 'firstKey' and create a duplicate with the key 'secondKey',
 * Do the same thing in reverse. If we find 'secondKey', create a duplicate with the key 'firstKey'.
 *
 * This will cause keys to be overwritten if the object contains 'firstKey' and 'secondKey'.

 * @param {*} input Any type of input
 * @param {String} firstKey The first key to duplicate
 * @param {String} secondKey The second key to duplicate
 */
function duplicateKeys(input, firstKey, secondKey) {
  // If array provided, recursively call on all elements
  if (_.isArray(input)) {
    return input.map((item) => duplicateKeys(item, firstKey, secondKey));
  }

  // If object, create duplicates for keys and then recursively call on values
  if (_.isPlainObject(input)) {
    const resultObj = {};
    for (let [key, value] of _.toPairs(input)) {
      const recursivelyCalledValue = duplicateKeys(value, firstKey, secondKey);
      if (key === firstKey) {
        resultObj[secondKey] = recursivelyCalledValue;
      } else if (key === secondKey) {
        resultObj[firstKey] = recursivelyCalledValue;
      }
      resultObj[key] = recursivelyCalledValue;
    }
    return resultObj;
  }

  // Base case. Return primitives without doing anything.
  return input;
}

/**
 * Takes a desired capability and tries to JSON.parse it as an array,
 * and either returns the parsed array or a singleton array.
 *
 * @param {string|Array<String>} cap A desired capability
 */
function parseCapsArray(cap) {
  if (_.isArray(cap)) {
    return cap;
  }

  let parsedCaps;
  try {
    parsedCaps = JSON.parse(cap);
    if (_.isArray(parsedCaps)) {
      return parsedCaps;
    }
  } catch (ign) {
    logger.warn(`Failed to parse capability as JSON array`);
  }
  if (_.isString(cap)) {
    return [cap];
  }
  throw new Error(`must provide a string or JSON Array; received ${cap}`);
}

/**
 * Generate a string that uniquely describes driver instance
 *
 * @param {import('@appium/types').Core} obj driver instance
 * @param {string?} sessionId session identifier (if exists)
 * @returns {string}
 */
function generateDriverLogPrefix(obj, sessionId = null) {
  const instanceName = `${obj.constructor.name}@${node.getObjectId(obj).substring(0, 4)}`;
  return sessionId ? `${instanceName} (${sessionId.substring(0, 8)})` : instanceName;
}

/** @type {import('@appium/types').DriverHelpers} */
export default {
  configureApp,
  isPackageOrBundle,
  duplicateKeys,
  parseCapsArray,
  generateDriverLogPrefix,
};
export {
  configureApp,
  isPackageOrBundle,
  duplicateKeys,
  parseCapsArray,
  generateDriverLogPrefix,
  BASEDRIVER_VER,
};

/**
 * @typedef RemoteAppProps
 * @property {Date?} lastModified
 * @property {boolean} immutable
 * @property {number?} maxAge
 * @property {string?} etag
 */

/**
 * @typedef RemoteAppData Properties of the remote application (e.g. GET HTTP response) to be downloaded.
 * @property {number} status The HTTP status of the response
 * @property {import('stream').Readable} stream The HTTP response body represented as readable stream
 * @property {import('axios').RawAxiosResponseHeaders | import('axios').AxiosResponseHeaders} headers HTTP response headers
 */
