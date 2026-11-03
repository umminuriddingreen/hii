const $ = id => document.getElementById(id);
const select = $('model-select');
const engineSelect = $('engine-select');
const actionMessage = $('action-message');
let installedModels = [];
const esc = value => String(value ?? '—').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

async function getJson(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function showStatus(status) {
  const loaded = status.loadedModel || 'No model reported';
  document.querySelector('.folder code').textContent = status.modelHome || '/Users/example/models';
  const ready = status.state === 'ready' && Boolean(status.loadedModel);
  $('runtime-state').textContent = ready ? `Runtime ready · ${loaded}` : `${status.state || 'Runtime state unknown'} · ${loaded}`;
  $('runtime-state').dataset.ready = String(ready);
  const platform = status.platform || {};
  const fields = [
    ['State', status.state], ['Runtime', status.backend || status.selection?.provider || platform.runtimeFamily],
    ['Model format', platform.modelFormat], ['Selected model', status.selection?.model || status.model],
    ['Loaded model', status.loadedModel], ['Endpoint', status.endpoint], ['Execution machine', status.executionMachine],
  ].filter(([, value]) => value != null && value !== '');
  $('runtime-details').innerHTML = fields.map(([name, value]) => `<dt>${esc(name)}</dt><dd>${esc(value)}</dd>`).join('');
}

function showInstalled(payload) {
  installedModels = Array.isArray(payload.data) ? payload.data.filter(model => model.installed !== false) : [];
  filterInstalled();
}

function runtimeForModel(model) {
  const format = String(model.format || model.modelFormat || '').toLowerCase();
  const backend = String(model.backend || '').toLowerCase();
  if (backend.includes('llama.cpp') || backend.includes('llamacpp')) return 'llama.cpp';
  if (backend.includes('mlx')) return 'mlx';
  if (format.includes('gguf')) return 'llama.cpp';
  if (format.includes('mlx') || format.includes('safetensors')) return 'mlx';
  return null;
}

function filterInstalled() {
  const prior = select.value;
  const engine = engineSelect.value;
  const models = installedModels.filter(model => engine === 'auto' || runtimeForModel(model) === engine);
  select.replaceChildren(new Option(models.length ? 'Choose an installed model…' : 'No compatible installed models found', ''));
  for (const model of models) {
    const id = model.model || model.logicalModel || model.id;
    if (!id) continue;
    const modelEngine = runtimeForModel(model);
    const option = new Option(`${id}${modelEngine ? ` · ${modelEngine === 'mlx' ? 'MLX native' : modelEngine}` : ''}`, id);
    option.dataset.backend = model.backend || '';
    option.dataset.path = model.modelPath || '';
    option.dataset.size = model.sizeBytes || '';
    option.dataset.engine = modelEngine || '';
    option.dataset.format = model.format || model.modelFormat || '';
    option.selected = id === prior;
    select.add(option);
  }
  if (!select.value) select.selectedIndex = 0;
  $('engine-note').textContent = engine === 'auto'
    ? `Automatic shows supported installed formats and infers MLX or llama.cpp from each model's file format (${models.length} found).`
    : `${engine === 'mlx' ? 'MLX native' : engine} filter · ${models.length} compatible installed model${models.length === 1 ? '' : 's'}.`;
  updateSelection();
}

function updateSelection() {
  const option = select.selectedOptions[0];
  const enabled = Boolean(select.value);
  $('use-model').disabled = !enabled;
  $('start-model').disabled = !enabled;
  const engine = option?.dataset.engine;
  const inferred = engine
    ? `${option.dataset.format ? 'Compatible runtime inferred from file format' : 'Compatible runtime from HII model backend'}: ${engine === 'mlx' ? 'MLX (native)' : 'llama.cpp'}${option.dataset.format ? ` · ${option.dataset.format}` : ''}`
    : 'No compatible runtime could be inferred from this model format.';
  const bits = [inferred, option?.dataset.path, option?.dataset.size ? `${(Number(option.dataset.size) / 1e9).toFixed(1)} GB` : ''].filter(Boolean);
  $('model-meta').textContent = enabled ? bits.join(' · ') : '';
}

async function refresh() {
  $('runtime-state').textContent = 'Checking HII…';
  try {
    const [status, installed] = await Promise.all([getJson('/api/models/status'), getJson('/api/models/installed')]);
    showStatus(status);
    showInstalled(installed);
  } catch (error) {
    $('runtime-state').textContent = `Could not read HII model state: ${error.message}`;
    $('runtime-state').dataset.ready = 'false';
    $('runtime-details').replaceChildren();
    select.replaceChildren(new Option('Installed model list unavailable', ''));
    updateSelection();
  }
}

async function act(path, verb) {
  if (!select.value) return;
  actionMessage.className = 'message';
  actionMessage.textContent = `${verb} requested for ${select.value}…`;
  $('use-model').disabled = $('start-model').disabled = true;
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: select.value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
    actionMessage.textContent = `${verb} command completed. Refreshing runtime status…`;
    await refresh();
  } catch (error) {
    actionMessage.className = 'message error';
    actionMessage.textContent = error.message;
  } finally { updateSelection(); }
}

select.addEventListener('change', updateSelection);
engineSelect.addEventListener('change', filterInstalled);
$('refresh').addEventListener('click', refresh);
$('use-model').addEventListener('click', () => act('/api/models/use', 'Choose model'));
$('start-model').addEventListener('click', () => act('/api/models/start', 'Start runtime'));
refresh();
