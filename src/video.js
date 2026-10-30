// Finds the YouTube video that's open on screen, so "summarise this video"
// works without copying the link. On Windows it reads the address bar of the
// browser window showing YouTube through UI Automation (the accessibility
// interface screen readers use), which works for Chrome, Edge, Brave, Opera
// and Firefox. If that fails, a YouTube link on the clipboard is used.
const { clipboard, desktopCapturer } = require('electron');
const { execFile } = require('child_process');

const YT = /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?[^\s]*v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i;

function normalise(text) {
  const m = YT.exec(text || '');
  return m ? `https://www.youtube.com/watch?v=${m[1]}` : null;
}

// Windows are listed front to back, so the YouTube window you looked at last
// wins. FindFirst stops at the browser's own address box before it reaches
// the page, which keeps this to well under a second.
const PS = `
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$A=[System.Windows.Automation.AutomationElement]; $T=[System.Windows.Automation.ControlType]
$P=[System.Windows.Automation.PropertyCondition]
$wins=$A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, (New-Object $P($A::ControlTypeProperty,$T::Window)))
foreach($w in $wins){
  if($w.Current.Name -notmatch 'YouTube'){ continue }
  $e=$w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object $P($A::ControlTypeProperty,$T::Edit)))
  if(-not $e){ continue }
  try { $v=$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { continue }
  if($v -match 'youtu'){ Write-Output ($w.Current.Name + [char]9 + $v); break }
}`;

function fromAddressBar() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS],
      { timeout: 6000, windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const [title, value] = stdout.trim().split('\t');
        const url = normalise(value);
        resolve(url ? { url, title: cleanTitle(title) } : null);
      });
  });
}

const cleanTitle = (t) => (t || '').replace(/\s*-\s*YouTube.*$/i, '').replace(/^\(\d+\)\s*/, '').trim();

async function find() {
  const found = await fromAddressBar();
  if (found) return found;
  const url = normalise(clipboard.readText());
  return url ? { url, title: '' } : null;
}

// Cheap check used when the bar opens: is any window showing YouTube?
// Returns the video title or null.
async function visibleTitle() {
  try {
    const wins = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    const w = wins.find((s) => / - YouTube\b/i.test(s.name));
    return w ? cleanTitle(w.name) : null;
  } catch {
    return null;
  }
}

const PROMPT = 'Summarise this YouTube video. Start with two or three sentences on what it is about, then list the key points as bullets, each starting with its timestamp in [m:ss] form. Finish with the main takeaway.';

module.exports = { find, visibleTitle, normalise, PROMPT };
