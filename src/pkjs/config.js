module.exports = [
  { "type": "heading", "defaultValue": "Tuya Lights" },
  {
    "type": "section",
    "items": [
      { "type": "heading", "defaultValue": "One-time setup" },
      {
        "type": "text",
        "defaultValue": "This app talks to Tuya's cloud, so it needs your own free Tuya developer keys (the official Tuya app can't be controlled directly).<br><br><b>1.</b> Go to <b>iot.tuya.com</b> and sign up. In the left menu pick <b>Cloud &gt; Development</b> and <b>Create Cloud Project</b> (type: Smart Home). This is a <i>Cloud Project</i>, not an <i>App</i>. Pick the <b>Data Center</b> for your region (e.g. Central Europe).<br><b>2.</b> The project shows an <b>Access ID</b> and <b>Access Secret</b> — paste them below.<br><b>3.</b> In the project open <b>Devices &gt; Link App Account</b> and scan the QR with the Smart&nbsp;Life app (<b>Me &gt; Scan</b>). Your lights then appear under the project.<br><b>4.</b> Choose the <b>same Data Center</b> below as your account's region."
      }
    ]
  },
  {
    "type": "section",
    "items": [
      { "type": "heading", "defaultValue": "Credentials" },
      { "type": "input", "messageKey": "TuyaAccessId", "label": "Access ID", "attributes": { "placeholder": "from your Cloud Project" } },
      { "type": "input", "messageKey": "TuyaAccessSecret", "label": "Access Secret", "attributes": { "placeholder": "from your Cloud Project" } },
      {
        "type": "select", "messageKey": "TuyaRegion", "label": "Data center",
        "defaultValue": "eu",
        "options": [
          { "label": "Central Europe (eu)", "value": "eu" },
          { "label": "Western America (us)", "value": "us" },
          { "label": "China (cn)", "value": "cn" },
          { "label": "India (in)", "value": "in" }
        ]
      },
      { "type": "text", "defaultValue": "Tip: the Data Center must match the region where your Smart Life account is registered, or no lights will appear." }
    ]
  },
  {
    "type": "section",
    "items": [
      { "type": "heading", "defaultValue": "Refresh" },
      {
        "type": "select", "messageKey": "TuyaPollInterval", "label": "Auto-refresh while open",
        "defaultValue": "0",
        "options": [
          { "label": "Off (refresh on open only)", "value": "0" },
          { "label": "Every 15 s", "value": "15" },
          { "label": "Every 30 s", "value": "30" },
          { "label": "Every 60 s", "value": "60" }
        ]
      },
      { "type": "text", "defaultValue": "State is always fetched when you open the app. Auto-refresh also re-polls while the app stays open (uses more data/battery)." }
    ]
  },
  { "type": "submit", "defaultValue": "Save" }
];
