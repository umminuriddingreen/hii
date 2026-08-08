/**
 * `hii object` — the governed object interface, from the command line.
 *
 * This is the path a CLI agent reaches objects through. It does not talk to
 * Workspace JSON and it does not reach the graph's mutation API directly; it
 * calls the same governed module the HTTP surface does, so object scope,
 * operation permissions, frame scope, stale-write refusal and VERIFIED_BY proof
 * are enforced identically wherever the request came from.
 *
 * The scope arrives as JSON on the command line because Slice 5 has no durable
 * grant store yet. Slice 7 replaces `--scope` with a persisted, human-approved
 * grant; nothing about the enforcement below changes when it does.
 */

function usage() {
  console.error(`usage: hii object <list|read|create|patch|annotate|project|relate|tombstone> [options]

  --scope <json>       approved object scope (required)
  --actor <id>         acting subject (required for writes)
  --run <id>           run this operation belongs to
  --intent <id>        intent this operation serves
  --receipt <path>     receipt backing a proof claim
  --proof <json>       completion proof, required for VERIFIED_BY
  --input <json>       operation payload
  --object <id>        object id, for read
  --json               machine-readable output`);
}

function parseArgs(argv) {
  const options = { json: false };
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    if (flag === '--json') {
      options.json = true;
      continue;
    }
    if (!flag.startsWith('--')) continue;
    options[flag.slice(2)] = argv[at + 1];
    at += 1;
  }
  return options;
}

function parseJsonFlag(value, flag) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`--${flag} must be JSON: ${error.message}`);
  }
}

export async function cmdObject(args) {
  const operation = args[0];
  if (!operation || operation === 'help' || operation === '--help') {
    usage();
    process.exit(operation ? 0 : 1);
  }
  const options = parseArgs(args.slice(1));
  const scope = parseJsonFlag(options.scope, 'scope');
  if (!scope) throw new Error('An approved object scope is required: pass --scope <json>.');
  const input = parseJsonFlag(options.input, 'input') ?? {};
  const proof = parseJsonFlag(options.proof, 'proof');

  const governed = await import('../lib/server/governed-objects.ts');
  const actor = {
    actorId: options.actor || 'hii:cli',
    ...(options.run ? { runId: options.run } : {}),
    ...(options.intent ? { intentId: options.intent } : {}),
    ...(options.receipt ? { receiptId: options.receipt } : {}),
    ...(proof ? { proof } : {})
  };

  let result;
  switch (operation) {
    case 'list':
      result = { objects: governed.listApprovedObjects(scope) };
      break;
    case 'read':
      if (!options.object) throw new Error('read needs --object <id>.');
      result = governed.readApprovedObject(scope, options.object);
      break;
    case 'create':
      result = governed.createApprovedObject(scope, actor, input);
      break;
    case 'patch':
      result = governed.patchApprovedObject(scope, actor, input);
      break;
    case 'annotate':
      result = governed.annotateApprovedObject(scope, actor, input);
      break;
    case 'project':
      result = governed.patchApprovedProjection(scope, actor, input);
      break;
    case 'relate':
      result = governed.createApprovedRelation(scope, actor, input);
      break;
    case 'tombstone':
      result = governed.tombstoneApprovedObject(scope, actor, input);
      break;
    default:
      usage();
      process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.objects) {
    for (const object of result.objects) {
      console.log(`${object.id}  ${object.type}  v${object.semanticVersion}${object.tombstoned ? '  (tombstoned)' : ''}`);
    }
    return;
  }
  if (result.object && result.history) {
    console.log(`${result.object.id}  ${result.object.type}  v${result.object.semanticVersion}`);
    console.log(`  owner: ${result.object.ownerActorId ?? 'unknown'}  source: ${result.object.canonicalSource}  provenance: ${result.object.provenanceClass}`);
    console.log(`  relations: ${result.relations.length}  operations: ${result.history.length}`);
    return;
  }
  console.log(
    `${result.applied ? 'applied' : result.replayed ? 'replayed' : 'no change'}  ${result.targetId ?? ''}  v${result.baseVersion ?? '-'} -> v${result.resultVersion ?? '-'}  op ${result.operationId}`
  );
}
