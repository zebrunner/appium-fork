
FROM alpine:3.19.1
FROM node:18-alpine


ENV PLATFORM_NAME=ANDROID
ENV DEVICE_UDID=

# Integration UUID for ReDroid integration
ENV ROUTER_UUID=

# Default appium 2.0 ueser:
# uid=1300(androidusr) gid=1301(androidusr) groups=1301(androidusr)





# Android envs
ENV ADB_PORT=5037
ENV ANDROID_DEVICE=
ENV ADB_POLLING_SEC=5

ENV PROXY_PORT=8080
ENV SERVER_PROXY_PORT=0

ENV CHROMEDRIVER_AUTODOWNLOAD=true

# Log settings
ENV LOG_LEVEL=info
ENV LOG_DIR=/tmp/log
ENV TASK_LOG=/tmp/log/appium.log
ENV LOG_FILE=session.log
ENV VIDEO_LOG=/tmp/log/appium-video.log
ENV VIDEO_LOG_FILE=video.log

# iOS envs
ENV WDA_HOST=connector
ENV WDA_PORT=8100
ENV MJPEG_PORT=8101
ENV WDA_WAIT_TIMEOUT=30
ENV WDA_LOG_FILE=/tmp/log/wda.log

# Screenrecord params
ENV SCREENRECORD_OPTS="--bit-rate 2000000"
ENV FFMPEG_OPTS=

# Timeout settings
ENV UNREGISTER_IF_STILL_DOWN_AFTER=60000

# #86 move usbreset onto the appium side
ENV DEVICE_BUS=/dev/bus/usb/003/011

# Usbmuxd settings "host:port"
ENV USBMUXD_SOCKET_ADDRESS=

# Debug mode vars
ENV DEBUG=false
ENV DEBUG_TIMEOUT=3600
ENV VERBOSE=false


ENV DEBIAN_FRONTEND=noninteractive

#==================
# General Packages
#------------------
# ca-certificates
#   SSL client
# curl
#   Transfer data from or to a server
# gnupg
#   Encryption software. It is needed for nodejs
# libgconf-2-4 (not available in alpine)
#   Required package for chrome and chromedriver to run on Linux
# libqt5webkit5 (not available in alpine)
#   Web content engine (Fix issue in Android)
# openjdk-11-jdk
#   Java
# sudo
#   Sudo user
# tzdata
#   Timezone
# unzip
#   Unzip zip file
# wget
#   Network downloader
# xvfb
#   X virtual framebuffer
# zip
#   Make a zip file
#==================
RUN apk update && apk add --no-cache \
    ca-certificates \
    curl \
    gnupg \
    openjdk11 \
    sudo \
    tzdata \
    unzip \
    wget \
    xvfb-run \
    bash \
    zip \
    && rm -rf /var/cache/apk/*
#===============
# Set JAVA_HOME
#===============


ENV JAVA_HOME=/usr/lib/jvm/java-11-openjdk \
    PATH=$PATH:$JAVA_HOME/bin

#===============================
# Set Timezone (UTC as default)
#===============================
ENV TZ=UTC
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/${TZ} /etc/localtime && \
    echo "${TZ}" > /etc/timezone && \
    apk del tzdata



ARG USER_PASS=secret
RUN addgroup -g 1301 androidusr && \
    adduser -u 1300 -G androidusr -D -s /bin/sh androidusr && \
    echo 'androidusr ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers

WORKDIR /home/androidusr

#=====================
# Install Android SDK
#=====================
# ENV SDK_VERSION=commandlinetools-linux-8512546_latest
# ENV ANDROID_BUILD_TOOLS_VERSION=34.0.0
# ENV ANDROID_FOLDER_NAME=cmdline-tools
# ENV ANDROID_DOWNLOAD_PATH=/home/androidusr/${ANDROID_FOLDER_NAME} \
#     ANDROID_HOME=/opt/android \
#     ANDROID_TOOL_HOME=/opt/android/${ANDROID_FOLDER_NAME}

# RUN wget -O tools.zip https://dl.google.com/android/repository/${SDK_VERSION}.zip && \
#     unzip tools.zip && rm tools.zip && \
#     chmod a+x -R ${ANDROID_DOWNLOAD_PATH} && \
#     chown -R 1300:1301 ${ANDROID_DOWNLOAD_PATH} && \
#     mkdir -p ${ANDROID_TOOL_HOME} && \
#     mv ${ANDROID_DOWNLOAD_PATH} ${ANDROID_TOOL_HOME}/tools
# ENV PATH=$PATH:${ANDROID_TOOL_HOME}/tools:${ANDROID_TOOL_HOME}/tools/bin

# # https://askubuntu.com/questions/885658/android-sdk-repositories-cfg-could-not-be-loaded
# RUN mkdir -p ~/.android && \
#     touch ~/.android/repositories.cfg && \
#     echo y | sdkmanager "platform-tools" && \
#     echo y | sdkmanager "build-tools;$ANDROID_BUILD_TOOLS_VERSION" && \
#     mv ~/.android .android && \
#     chown -R 1300:1301 .android
# ENV PATH=$PATH:$ANDROID_HOME/platform-tools:$ANDROID_HOME/build-tools

#====================================
# Install appium and customize it 
#====================================

WORKDIR /appium-fork

COPY . /appium-fork

# build appium with custom patches 
RUN npm i  

RUN ln -s /appium-fork/node_modules/.bin/appium /usr/local/bin/appium

# Enable local caching for appium instances
ENV APPIUM_PORT=4723
ENV APPIUM_HOME=/appium-fork
ENV APPIUM_APPS_DIR=/opt/appium-storage
ENV APPIUM_APP_WAITING_TIMEOUT=600
ENV APPIUM_MAX_LOCK_FILE_LIFETIME=1800
ENV APPIUM_APP_FETCH_RETRIES=0
ENV APPIUM_CLI=

ENV APPIUM_APP_SIZE_DISABLE=false

ENV APPIUM_PLUGINS=


# ====================================================
# Fix permission issue to download e.g. chromedriver
# ====================================================
RUN chown -R 1300:1301 /appium-fork



# =======
# Add ADB
# =======
RUN apk add \
    android-tools \
    --repository=http://dl-cdn.alpinelinux.org/alpine/edge/testing


#==================
# Use created user
#==================
# USER 1300:1301


USER root
RUN mkdir -p $APPIUM_APPS_DIR && \
    chown androidusr:androidusr $APPIUM_APPS_DIR
#Grab gidevice from github and extract it in a folder
RUN wget https://github.com/danielpaulus/go-ios/releases/download/v1.0.121/go-ios-linux.zip && \
    unzip go-ios-linux.zip -d /usr/local/bin && \
    rm go-ios-linux.zip

# https://github.com/danielpaulus/go-ios/releases/latest/download/go-ios-linux.zip
# RUN unzip go-ios-linux.zip -d /usr/local/bin

COPY files/start-capture-artifacts.sh /opt


# Zebrunner MCloud node config generator
COPY files/debug.sh /opt
COPY files/android.sh /opt
COPY files/zbr-config-gen.sh /opt
COPY files/zbr-default-caps-gen.sh /opt

ENV ENTRYPOINT_DIR=/opt/entrypoint
RUN mkdir -p ${ENTRYPOINT_DIR}
COPY entrypoint.sh ${ENTRYPOINT_DIR}

# removed copy device_connect because of in this PR device_connect.sh was deleted https://github.com/zebrunner/appium/pull/371/files
# COPY device_connect.sh ${ENTRYPOINT_DIR}


#TODO: think about entrypoint container usage to apply permission fixes
#RUN chown -R androidusr:androidusr $ENTRYPOINT_DIR

# Healthcheck
COPY files/healthcheck /usr/local/bin
COPY files/usbreset /usr/local/bin

#TODO: migrate everything to androiduser
#USER androidusr


RUN appium driver list && \
	appium plugin list

#TODO:/ think about different images per each device platform


ENV APPIUM_DRIVER_UIAUTOMATOR2_VERSION="2.45.0"
ENV APPIUM_DRIVER_XCUITEST_VERSION="7.7.2"
RUN appium driver install --source=npm appium-uiautomator2-driver@${APPIUM_DRIVER_UIAUTOMATOR2_VERSION} && \
    appium driver install --source=npm appium-xcuitest-driver@${APPIUM_DRIVER_XCUITEST_VERSION}

#===============
# Expose Port
#---------------
# 4723
#   Appium port
#===============
EXPOSE 4723


#override CMD to have PID=1 for the root process with ability to handle trap on SIGTERM
CMD ["/opt/entrypoint/entrypoint.sh"]

HEALTHCHECK --interval=10s --retries=3 CMD ["healthcheck"]
