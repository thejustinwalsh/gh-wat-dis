# Ask the user

Some steps need a decision from the person: a config value, a scope, a yes for a batch. Ask for one decision at a time.

## With a question tool

Use the question tool of your harness when your tool list has one. It shows the options as a list, and one click answers.

| Harness | Question tool |
|---|---|
| Claude Code | `AskUserQuestion` |
| Codex | `request_user_input`. Codex offers it in Plan mode. In other modes it is often absent. |
| OpenCode | `question` |
| Cursor | `AskQuestion`. It depends on the mode and the model. |
| Gemini CLI | `ask_user` |
| GitHub Copilot | `askQuestions` in VS Code, `ask_user` in the Copilot CLI |

Tool names change between versions. Trust your tool list over this table: use any tool there that asks the user a question with options, and do not call one that is not there.

- Ask one decision in each call, with 2 to 4 options.
- Put the option you recommend first and say why in its description.
- Print a draft or a table in the chat before the call. The tool shows only short text.

## With no question tool

Ask in plain turns.

1. Write one question.
2. List the options with numbers, and name the one you recommend.
3. End your turn and wait for the answer.

Do not ask a second question in the same message. Do not go on with a guess.

## Approving a batch

A batch is one question with three answers: apply all rows, apply some (the user names the row numbers), apply none.
