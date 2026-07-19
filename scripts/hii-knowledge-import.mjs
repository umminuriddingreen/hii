#!/usr/bin/env node
import {
  executeKnowledgeImport,
  exportKnowledgeVault,
  knowledgeImportStatus,
  planKnowledgeImport,
  rollbackKnowledgeImport,
  verifyKnowledgeImport
} from '../lib/server/hii-knowledge-import.ts';

const [command = 'status', ...args] = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const usage = `usage: hii-knowledge-import.mjs <command> [options]

commands:
  plan     --source <absolute vault path>
  execute  --batch <id> --plan-hash <sha256> --approval-token <token>
  verify   --batch <id>
  rollback --batch <id>
  export   --destination <empty directory>
  status   [--batch <id>]`;

let result;
if (command === '--help' || command === '-h' || command === 'help') {
  console.log(usage);
  process.exit(0);
} else if (command === 'plan') result = planKnowledgeImport(flag('--source'));
else if (command === 'execute') result = executeKnowledgeImport(flag('--batch'), flag('--plan-hash'), flag('--approval-token'));
else if (command === 'verify') result = verifyKnowledgeImport(flag('--batch'));
else if (command === 'rollback') result = rollbackKnowledgeImport(flag('--batch'));
else if (command === 'export') result = exportKnowledgeVault(flag('--destination'));
else if (command === 'status') result = knowledgeImportStatus(flag('--batch'));
else throw new Error(usage);

console.log(JSON.stringify(result, null, 2));
