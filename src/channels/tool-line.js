// What to show while the agent runs a tool and has not written anything yet. Shared by Telegram and the web chat.
export function toolLine(name, input = {}) {
  if (/^mcp__playwright__/.test(name)) {
    if (name === 'mcp__playwright__browser_navigate' && input.url) {
      try { const host = new URL(input.url).host; if (host) return `Opening ${host}...`; } catch {}
    }
    return 'Using the browser...';
  }
  const cmd = [input.command, input.file_path, input.path, input.pattern, input.query].filter(Boolean).map(String).join(' ');
  if (/mastan-me-coder/.test(cmd)) return 'Coder is working...';
  if (/mastan-fleet\s+run\b/.test(cmd)) return 'Asking for your passkey...';
  if (/mastan-fleet\s+wait\b/.test(cmd)) return 'Waiting for your passkey...';
  if (/mastan-fleet/.test(cmd)) return 'Checking the server...';
  if (/mastan-me-board/.test(cmd)) return 'Checking the board...';
  if (/mastan-me-youtube/.test(cmd)) return 'Checking YouTube...';
  if (/memory\//.test(cmd)) return 'Looking in memory...';
  if (/atlas\//.test(cmd)) return 'Checking the atlas...';
  if (/inbox\//.test(cmd)) return 'Looking at the file...';
  if (/^mcp__smartsheet__/.test(name)) return /_(write|rows|columns?|sheet|folder|workspace)$/.test(name) && !/^mcp__smartsheet__(get|find|list|browse|search)/.test(name) ? 'Working in Smartsheet...' : 'Reading Smartsheet...';
  if (/^mcp__/.test(name)) return `Working (${name.split('__')[1]})...`;
  if (/^(Read|Grep|Glob)$/.test(name)) return 'Reading files...';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return 'Writing files...';
  if (/^Web(Search|Fetch)$/.test(name)) return 'Searching the web...';
  if (/^(Task|Agent)$/.test(name)) return 'Delegating a sub-task...';
  if (name === 'Bash') return 'Running a command...';
  return `Working (${name})...`;
}
