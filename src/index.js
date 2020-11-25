const axios = require('axios');
const moment = require('moment');
const fs = require('fs');
const mqtt = require('mqtt');

const Logger = require('home-assistant-addon-helpers/logger');

const CONFIG_FILE_PATH = process.env.CONFIG_FILE;
const HISTORY_FILE_PATH = process.env.HISTORY_FILE;

const DEFAULT_DISCOVERY_TOPIC = 'homeassistant/sensor/erie_septic_tank/space/config';
const DEFAULT_STATE_TOPIC = 'erie_septic_tank/state';
const DEFAULT_RESET_TOPIC = 'erie_septic_tank/reset';
const DEFAULT_HA_STATUS_TOPIC = 'homeassistant/status';
const DEFAULT_SENSOR_NAME = 'Erie septic tank';

const HANDSHAKE_TIMEOUT = 10000;

const EC_API_BASE_PATH = 'https://erieconnect.eriewatertreatment.com/api/erieapp/v1';
const EC_ENDPOINTS = {
  LOGIN: '/auth/sign_in',
  DEVICE_LIST: '/water_softeners',
  INFO: deviceId => `/water_softeners/${deviceId}/info`
};

const logger = new Logger('Erie septic tank');

(() => {
  let CONFIG, resetHistory;

  if (!fs.existsSync(CONFIG_FILE_PATH)) {
    throw new Error(`Config file (${CONFIG_FILE_PATH}) does not exist`);
  }

  CONFIG = require(CONFIG_FILE_PATH);
  logger.log('config file loaded:', CONFIG_FILE_PATH);

  if (!fs.existsSync(HISTORY_FILE_PATH)) {
    logger.log('History file does not exist:', HISTORY_FILE_PATH);
  } else {
    resetHistory = require(HISTORY_FILE_PATH);
    logger.log('history file loaded:', HISTORY_FILE_PATH);
  }

  checkConfig(CONFIG);

  const { config, erieConnect } = CONFIG;
  const mqttConfig = CONFIG.mqtt;

  const discoveryTopic = mqttConfig.discoveryTopic || DEFAULT_DISCOVERY_TOPIC;
  const stateTopic = mqttConfig.stateTopic || DEFAULT_STATE_TOPIC;
  const resetTopic = mqttConfig.resetTopic || DEFAULT_RESET_TOPIC;
  const statusTopic = mqttConfig.ha_status_topic || DEFAULT_HA_STATUS_TOPIC;
  const sensorName = mqttConfig.sensorName || DEFAULT_SENSOR_NAME;
  const interval = config.interval || 60;

  logger.log(`stateTopic:`, stateTopic);
  logger.log(`resetTopic:`, resetTopic);
  logger.log(`sensorName:`, sensorName);
  logger.log(`statusTopic:`, statusTopic);

  // erie connect app data
  let cachedDeviceId = null;
  const HEADERS = {
    'Access-Token': null,
    Client: null,
    'Token-Type': 'Bearer',
    Expiry: null,
    Uid: null
  };

  const mqttClient = mqtt.connect(mqttConfig.server, {
    username: mqttConfig.username,
    password: mqttConfig.password
  });

  mqttClient.on('connect', () => {
    logger.log(`connected with mqtt broker:`, mqttConfig.server);
  });

  mqttClient.subscribe(resetTopic);
  mqttClient.subscribe(statusTopic);

  mqttClient.on('message', (topic, buffer) => {
    const message = buffer.toString();

    logger.log(`received message with topic: ${topic}`, message);
    switch (topic) {
      case statusTopic:
        if ((message || '').toLowerCase() === 'online') {
          // home assistant handshake when HA becomes online
          setTimeout(() => haHandshake(), HANDSHAKE_TIMEOUT);
        }
        break;
      case resetTopic:
        reset();
        break;
    }
  });

  logger.log(`init schedule: every ${interval} seconds`);

  // verify lastReset source
  if (Array.isArray(resetHistory) && resetHistory.length) {
    const lastReset = resetHistory[resetHistory.length - 1];
    if (lastReset.value > config.lastReset) {
      logger.log('update lastReset value in memory to: ', lastReset.value);
      config.lastReset = lastReset.value;
    }
  }

  scheduleFetch();
  // initial home assistant handshake, when HA is available
  // before addon started
  setTimeout(() => haHandshake(), HANDSHAKE_TIMEOUT);

  function scheduleFetch() {
    setTimeout(() => {
      fetchAndPublish();
      scheduleFetch();
    }, interval * 1000);
  }

  function fetchAndPublish() {
    fetch().then(data => publish(data));
  }

  function publish(data) {
    if (!mqttClient.connected) {
      logger.log('mqtt server disconnected.');
      return;
    }

    if (Array.isArray(resetHistory)) {
      const lastReset = resetHistory[resetHistory.length - 1];
      Object.assign(data, {
        last_reset_date: lastReset.date,
        last_reset_timestamp: lastReset.timestamp
      });
    }

    const message = JSON.stringify(data);

    logger.log(`Publish: ${stateTopic} with payload: `, message);
    mqttClient.publish(stateTopic, message);
  }

  function fetch() {
    if (!HEADERS['Access-Token']) {
      return login().then(() => getTotalWaterUsage());
    } else {
      return getTotalWaterUsage();
    }
  }

  function reset() {
    const history = Array.isArray(resetHistory) ? [...resetHistory] : [];
    const timestamp = Date.now();

    // save initial state
    if (!history.length) {
      history.push({
        date: 'initial',
        value: config.lastReset
      });
    }

    // save new reset
    fetch().then(data => {
      // update lastReset value in memory
      config.lastReset = data.total;

      history.push({
        date: moment(timestamp).format('DD/MM/YYYY HH:mm:ss'),
        timestamp,
        value: config.lastReset
      });
      logger.log('New reset history entry in memory.');

      logger.log('Attempt to history file update.');
      fs.writeFileSync(HISTORY_FILE_PATH, JSON.stringify(history, null, 2), {
        encoding: 'utf-8'
      });

      logger.log('History file updated.');

      // update history in memory
      resetHistory = history;
    });
  }

  function haHandshake() {
    if (!mqttClient.connected) {
      logger.log('mqtt server disconnected.');
      return;
    }

    logger.log(`hello to homeassistant discovery:`, discoveryTopic);
    mqttClient.publish(
      discoveryTopic,
      JSON.stringify({
        name: sensorName,
        state_topic: stateTopic,
        json_attributes_topic: stateTopic,
        unique_id: 'erie_septic_tank',
        unit_of_measurement: 'L',
        value_template: '{{ value_json.space_left }}'
      })
    );
  }

  // ERIE CONNECT API HELPERS:
  //
  // * getTotalWaterUsage
  // * getInfo
  // * getDevices
  // * login
  function getTotalWaterUsage() {
    if (cachedDeviceId) {
      logger.log('ErieConnect - Using cached device id.');
      return getInfo(cachedDeviceId);
    }

    return getDevices()
      .then(devices => {
        if (!devices.length) {
          throw new Error('ErieConnect - No devices.');
        }

        cachedDeviceId = devices[0].profile.id;
        return cachedDeviceId;
      })
      .then(deviceId => getInfo(deviceId));
  }

  function getInfo(deviceId) {
    logger.log('ErieConnect - Get info started.');

    return request(EC_ENDPOINTS.INFO(deviceId)).then(info => {
      const total = parseInt(info.total_volume, 10);
      logger.log('ErieConnect - Info fetched.');
      return {
        updated: Date.now(),
        total,
        regenerations: info.nr_regenerations,
        tank_size: config.tankSize,
        last_reset: config.lastReset,
        space_left: config.tankSize - (total - config.lastReset)
      };
    });
  }

  function getDevices() {
    logger.log('ErieConnect - Get devices start.');
    return request(EC_ENDPOINTS.DEVICE_LIST);
  }

  function login() {
    logger.log('ErieConnect - Login start.');
    return axios
      .post(EC_API_BASE_PATH + EC_ENDPOINTS.LOGIN, erieConnect)
      .then(res => {
        HEADERS['Access-Token'] = res.headers['access-token'];
        HEADERS['Client'] = res.headers.client;
        HEADERS['Expiry'] = res.headers.expiry;
        HEADERS['Uid'] = res.headers.uid;

        logger.log('ErieConnect - User logged in.');
      })
      .catch(error => console.logger.log(error));
  }

  function request(path) {
    return axios
      .get(EC_API_BASE_PATH + path, { headers: HEADERS })
      .then(res => res.data)
      .catch(res => {
        if (res.response.status === 401) {
          logger.log('No active session. Login retry.');
          return login().then(() => request(path));
        }
        logger.log('Error response. ' + JSON.stringify({ path, statusCode: res.response.status }));
        return {};
      });
  }

  function checkConfig() {
    if (!CONFIG.config) {
      throw new Error(`Wrong configuration: Missing config object.`);
    }

    if (!(CONFIG.config.tankSize && CONFIG.config.lastReset)) {
      throw new Error(`Wrong configuration: config object should cointain tankSize and lastReset.`);
    }

    if (!CONFIG.erieConnect) {
      throw new Error(`Wrong configuration: Missing erieConnect object.`);
    }

    if (!(CONFIG.erieConnect.email && CONFIG.erieConnect.password)) {
      throw new Error(`Wrong configuration: erieConnect object should contain email and password.`);
    }

    if (!CONFIG.mqtt) {
      throw new Error(`Wrong configuration: Missing mqtt object.`);
    }

    if (!(CONFIG.mqtt.server && CONFIG.mqtt.username && CONFIG.mqtt.password)) {
      throw new Error(`Wrong configuration: mqtt object should contain: server, username and password.`);
    }
  }
})();
