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
      { "type": "heading", "defaultValue": "Devices & scenes" },
      { "type": "text", "defaultValue": "Pick the lights and scenes to show on the watch, in order. Reorder with ▲/▼, remove with ✕, add with “+ Add”. Open this page once after saving your credentials so the list can load.<br><br>Scenes (tap-to-run) also need the <b>Smart Home Scene Linkage</b> API subscribed in your Tuya Cloud project (Service API &gt; Authorize)." },
      { "type": "catalogStore", "messageKey": "TuyaCatalog", "defaultValue": "" },
      { "type": "selectionList", "messageKey": "TuyaSelection", "defaultValue": [] }
    ]
  },
  {
    "type": "section",
    "items": [
      { "type": "heading", "defaultValue": "Behavior" },
      { "type": "toggle", "messageKey": "CfgQuickToggle",
        "label": "Tap in list toggles the light (hold to open controls)",
        "description": "When on, a short tap on a list row toggles that light; hold to open the per-light control window. When off, a tap opens the control window.",
        "defaultValue": true },
      { "type": "toggle", "messageKey": "CfgAutoClose",
        "label": "Close the app after toggling",
        "description": "When on, the app closes back to the watchface once the phone confirms the cloud command.",
        "defaultValue": false },
      { "type": "toggle", "messageKey": "CfgMru",
        "label": "Auto-organize list (recent first, offline last)",
        "description": "When off, the watch shows lights and scenes in the exact order you set above. When on, entries you use most recently move to the top and offline lights sink to the bottom.",
        "defaultValue": false },
      { "type": "select", "messageKey": "TuyaPollInterval", "label": "Auto-refresh while open",
        "description": "State is always fetched when you open the app. Auto-refresh also re-polls while the app stays open (uses more data/battery).",
        "defaultValue": "0",
        "options": [
          { "label": "Off (refresh on open only)", "value": "0" },
          { "label": "Every 15 s", "value": "15" },
          { "label": "Every 30 s", "value": "30" },
          { "label": "Every 60 s", "value": "60" }
        ]
      },
      { "type": "select", "messageKey": "CfgIdleExitSec", "label": "Return to watchface when idle",
        "description": "Close back to the watchface after this many seconds with no button press in the light list or control window. Off disables it.",
        "defaultValue": "15",
        "options": [
          { "label": "Off", "value": "0" },
          { "label": "10 seconds", "value": "10" },
          { "label": "15 seconds", "value": "15" },
          { "label": "30 seconds", "value": "30" },
          { "label": "60 seconds", "value": "60" }
        ]
      }
    ]
  },
  { "type": "submit", "defaultValue": "Save" }
];
