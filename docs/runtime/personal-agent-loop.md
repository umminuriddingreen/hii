# Personal agent conversations

The personal page at localhost:4188 defaults to a persistent HII agent loop. Conversations save private working state in ~/.hii/agents/chat-loops/CHAT_ID.json. The web transcript remains in the HII workspace store. A coordinator uses the selected Mac model and chooses a direct response, HII CLI tool run, or separate bounded helper run. Helper results return to the same coordinator conversation. Runs use the existing HII registry and disabled hooks.

Working context compacts after 18,000 serialized characters, retaining eight recent messages and a factual summary capped at 3,500 characters. /compact requests early compaction. Original web messages remain saved. At most three tool tasks execute per turn, sequentially, to avoid competing model loads. The turn timeout is ten minutes; each CLI task retains its own 20-step/three-minute limit. Stop cancels the owned process. Tool authority is limited to /Users/ummi/hii-model-chat. Agent tools currently use the Mac route.

- `/agent TASK`: request a separate helper inside the active chat.
- `/compact`: compact working memory.
- `/run`: switch between agent loop and plain model chat.
- `hii agents chat show CHAT_ID`: inspect durable context.
- `hii agents chat send CHAT_ID [--model MODEL] TASK`: continue the same conversation.
- `hii agents chat helper CHAT_ID [--model MODEL] TASK`: run a helper.
- `hii agents chat compact CHAT_ID`: compact memory.
- `hii agents chat stop CHAT_ID`: stop the active turn.

CLI commands use the always-on localhost service; the page polls for new CLI messages every fifteen seconds while idle. The installed shell launcher routes this command to the Node CLI until the next native release. The executor and transport live in hii-model-chat; reusable loop implementation is mirrored in runtime/agents/chat-loop.mjs. External Codex/Claude sessions remain read-only.
