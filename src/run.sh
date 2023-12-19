#!/bin/bash
set -e

CONFIG_PATH=/data/options.json

CONFIG_FILE=$(jq --raw-output ".configFile" $CONFIG_PATH)
HISTORY_FILE=$(jq --raw-output ".historyFile" $CONFIG_PATH)

echo Using config file: $CONFIG_FILE

echo Node version:
node -v

echo NPM version:
npm -v

pwd
npm ci

CMD="CONFIG_FILE=${CONFIG_FILE} HISTORY_FILE=${HISTORY_FILE} npm start"
eval $CMD