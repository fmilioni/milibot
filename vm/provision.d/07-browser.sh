# shellcheck shell=bash disable=SC2034
if [ -f /etc/apt/sources.list.d/google-chrome.list ] && retry apt_install google-chrome-stable; then
  BROWSER=google-chrome-stable
else
  retry apt_install chromium
  BROWSER=chromium
fi
# The Chrome package drops its own source list; keep a single definition.
for f in /etc/apt/sources.list.d/google-chrome*.list /etc/apt/sources.list.d/google-chrome*.sources; do
  [ -e "$f" ] && [ "$f" != /etc/apt/sources.list.d/google-chrome.list ] && rm -f "$f"
done
POLICY='{"DefaultBrowserSettingEnabled":false,"MetricsReportingEnabled":false,"PromotionalTabsEnabled":false,"BackgroundModeEnabled":false,"PrivacySandboxPromptEnabled":false,"HardwareAccelerationModeEnabled":false}'
install -d /etc/opt/chrome/policies/managed /etc/chromium/policies/managed
echo "$POLICY" > /etc/opt/chrome/policies/managed/milibot.json
echo "$POLICY" > /etc/chromium/policies/managed/milibot.json
