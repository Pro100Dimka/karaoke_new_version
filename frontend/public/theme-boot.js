// Applies the saved theme before the first paint so the backdrop never flashes an unthemed colour.
(function () {
  try {
    var stored = JSON.parse(window.localStorage.getItem("adVoice.preferences.v1") || "null");
    var themes = ["dark", "light", "green", "violet"];
    document.documentElement.dataset.theme = stored && themes.indexOf(stored.theme) >= 0 ? stored.theme : "dark";
  } catch (error) {
    document.documentElement.dataset.theme = "dark";
  }
})();
