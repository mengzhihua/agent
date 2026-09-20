export function completionScript(shell: string): string {
  const name = shell.trim().toLowerCase();
  if (name === "bash") return bashCompletion();
  if (name === "zsh") return zshCompletion();
  if (name === "powershell" || name === "pwsh") return powershellCompletion();
  throw new Error("usage: agent completion bash|zsh|powershell");
}

function bashCompletion(): string {
  return `# bash completion for agent
_agent() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local cmds="acp eval session memory doctor update uninstall serve completion config init login logout --help --version --print --quiet --output-format --yes --plan --workspace --continue --resume --list --file --model --provider --sandbox --browser --no-mcp"
  COMPREPLY=( $(compgen -W "$cmds" -- "$cur") )
}
complete -F _agent agent
`;
}

function zshCompletion(): string {
  return `#compdef agent
_agent() {
  local -a cmds
  cmds=(
    'acp:ACP JSON-RPC on stdio'
    'eval:Run deterministic eval fixtures'
    'session:List, inspect, export, fork, rewind, compact, cost, or delete sessions'
    'memory:Show durable user and project memory'
    'doctor:Show install and runtime diagnostics'
    'update:Re-run the one-click installer'
    'uninstall:Remove shims and checkout'
    'serve:HTTP + web console (SSE /v1/prompt)'
    'init:Scaffold AGENTS.md and .agent/'
    'login:Save API keys to ~/.agent/credentials.json'
    'logout:Remove saved API keys'
    'completion:Print shell completion script'
    'config:Show effective config'
    '--help'
    '--version'
    '--print'
    '--quiet'
    '--output-format'
    '--yes'
    '--plan'
    '--workspace'
    '--continue'
    '--resume'
    '--list'
    '--file'
    '--model'
    '--provider'
    '--sandbox'
    '--browser'
    '--no-mcp'
  )
  _describe 'command' cmds
}
_agent "$@"
`;
}

function powershellCompletion(): string {
  return `Register-ArgumentCompleter -Native -CommandName agent -ScriptBlock {
  param($wordToComplete)
  $cmds = @(
    'acp','eval','session','memory','doctor','update','uninstall','serve','completion','config','init','login','logout',
    '--help','--version','--print','--quiet','--output-format','--yes','--plan','--workspace','--continue','--resume',
    '--list','--file','--model','--provider','--sandbox','--browser','--no-mcp'
  )
  $cmds | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`;
}
