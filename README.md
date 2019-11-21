> Description

This is hass.io addon calculating space left in your septic tank based on `Erie Water IQSoft` device API.

To make it work you need to create config json file inside `/share` directory.

Example config:

`/share/erie-septic-tank/config.json`

```javascript
{
  "config": {
    "tankSize": 10000, // your septic tank size (liters)
    "lastReset": 104797, // total water usage in ErieConnect app when last emptying happened
    "interval": 10 // how often to update state (seconds)
  },
  "erieConnect": {
    "email": "admin@example.com",
    "password": "pass123"
  },
  "mqtt": {
    "server": "http://10.0.0.5:1883", // mqtt broker server address (with port)
    "username": "admin",
    "password": "abc123",

    "sensorName": null, // optional, default: erie_septic_tank
    "discovery_topic": null, // optional, default: homeassistant/sensor/erie_septic_tank/space/config
    "state_topic": null, // optional, erie_septic_tank/state
    "reset_topic": null // optional, erie_septic_tank/reset
  }
}
```

> MQTT Topics

Send message (empty) with topic `erie_septic_tank/reset` (could be customized via config) if you want to reset usage of water (tank emptying day).

New reset will be stored in reset history file and used for next calculations.