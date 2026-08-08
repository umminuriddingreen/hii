/**
 * `hii object` — the governed object interface, from the command line.
 *
 * This is the path a CLI agent reaches objects through. It does not talk to
 * Workspace JSON and it does not reach the graph's mutation API directly; it
 * calls the same governed module the HTTP surface does, so object scope,
 * operation permissions, frame scope, stale-write refusal and VERIFIED_BY proof
 * are enforced identically wherever the request came from.
 *
 * The scope is read from an approved grant, never taken from the command line.
 * `--scope` remains only so a test or a first-run bootstrap can pass an explicit
 * scope; it is refused unless HII_ALLOW_INLINE_OBJECT_SCOPE is set, because a
 * caller describing its own authority is not authority.
 */

function usage() {
  console.error(`usage: hii object <list|read|create|patch|annotate|project|relate|tombstone> [options]

  --grant <id>         approved object grant to act under (required)
  --scope <json>       explicit scope; needs HII_ALLOW_INLINE_OBJECT_SCOPE
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
  let scope;
  if (options.grant) {
    const { scopeForGrant } = await import('../lib/server/object-grants.ts');
    ({ scope } = await scopeForGrant(options.grant));
  } else if (options.scope) {
    if (!process.env.HII_ALLOW_INLINE_OBJECT_SCOPE) {
      throw new Error(
        'An inline --scope is a caller describing its own authority. Pass --grant <id> for an approved grant, or set HII_ALLOW_INLINE_OBJECT_SCOPE for a bootstrap or test.'
      );
    }
    scope = parseJsonFlag(options.scope, 'scope');
  }
  if (!scope) throw new Error('An approved object grant is required: pass --grant <id>.');
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
