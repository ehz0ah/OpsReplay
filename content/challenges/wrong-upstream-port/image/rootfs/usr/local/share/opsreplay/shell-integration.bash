# Learner-controlled shell integration. These markers are not an assessment boundary.
# PS0 runs once for each submitted top-level command, not once per simple command.
HISTCONTROL=
HISTIGNORE=
HISTSIZE=5000
HISTFILESIZE=0
HISTFILE=/dev/null

__opsreplay_command_start() {
    local command
    # fc -1 in PS0 can return the previous command. history 1 includes the
    # submitted command before execution, including its continued input lines.
    command=$(HISTTIMEFORMAT= builtin history 1)
    if [[ $command =~ ^[[:blank:]]*[0-9]+[[:blank:]][[:blank:]](.*)$ ]]; then
        command=${BASH_REMATCH[1]}
    else
        command='[command unavailable]'
    fi
    # Bound the marker before base64 expansion. The Gateway also validates its size.
    if (( ${#command} > 4000 )); then
        builtin printf '\033]133;T\007'
    fi
    command=${command:0:4000}
    builtin printf '\033]133;C;%s\007' "$(builtin printf '%s' "$command" | /usr/bin/base64 -w 0)"
}

__opsreplay_prompt() {
    local status=$?
    builtin printf '\033]133;D;%s\007' "$status"
}

PS0='$(__opsreplay_command_start)'
PROMPT_COMMAND=__opsreplay_prompt
PS1='\[\e]133;A\a\]\u@\h:\w# \[\e]133;B\a\]'
