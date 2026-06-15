module.exports = [
  { "type": "heading", "defaultValue": "Tuya Lights" },
  { "type": "text", "defaultValue": "Create a free Tuya IoT Cloud project, link your Smart Life account, and paste the project's credentials here." },
  {
    "type": "section",
    "items": [
      { "type": "heading", "defaultValue": "Tuya credentials" },
      { "type": "input", "messageKey": "TuyaAccessId", "label": "Access ID / Client ID", "attributes": { "placeholder": "Access ID" } },
      { "type": "input", "messageKey": "TuyaAccessSecret", "label": "Access Secret", "attributes": { "placeholder": "Access Secret" } },
      {
        "type": "select", "messageKey": "TuyaRegion", "label": "Data center",
        "defaultValue": "eu",
        "options": [
          { "label": "Central Europe (eu)", "value": "eu" },
          { "label": "Western America (us)", "value": "us" },
          { "label": "China (cn)", "value": "cn" },
          { "label": "India (in)", "value": "in" }
        ]
      }
    ]
  },
  { "type": "submit", "defaultValue": "Save" }
];
