const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escape = value => String(value ?? '').replace(/[&<>"']/g, character => entities[character]);

export async function api(path, { method = 'GET', data } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method, headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  } catch {
    throw new Error('Falha de ligação. Verifique a rede e tente novamente.');
  }
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(value.error || 'O pedido não pôde ser concluído.');
    error.status = response.status;
    throw error;
  }
  return value;
}

export function showError(element, error) {
  element.textContent = error?.message || '';
  element.hidden = !error;
}

export const blockNames = { training: 'Treino', baseline: 'Fase inicial', stopgo: 'Fase com sinal de paragem' };
export const conditionNames = { go: 'Go', nogo: 'No-Go', stop: 'Paragem' };
export const fmt = value => new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 1 }).format(value);
