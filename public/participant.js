import { api, escape as e, showError, blockNames, fmt } from './ui.js';
import { keyLabel, runBlock } from './engine.js';

const app = document.querySelector('#app');
const code = new URLSearchParams(location.search).get('code');
let test;
let credentials;
let attempt;
const responses = [];

function screen(title, content, label = 'Participação no estudo') {
  app.innerHTML = `<section class="panel study-card"><header class="study-heading"><p class="eyebrow">${e(label)}</p><h1>${e(title)}</h1></header><div class="study-content stack">${content}</div></section>`;
  window.scrollTo(0, 0);
}

function unavailable(error) {
  screen('Convite indisponível', `<p>${e(error.message)}</p><p>Se precisar de ajuda, contacte a equipa de investigação que enviou o convite.</p>`);
}

async function load() {
  if (!code) return unavailable(new Error('Abra a ligação do teste que recebeu para participar.'));
  try {
    test = await api('/api/test?code=' + encodeURIComponent(code));
  } catch (error) {
    return unavailable(error);
  }
  const { config, type } = test;
  screen(config.title, `
    ${config.description ? `<p class="prose">${e(config.description)}</p>` : ''}
    ${type === 'survey' ? '' : '<p>Pode responder com o teclado ou tocar ou clicar na área dos estímulos. Mantenha esta janela ativa durante o teste.</p>'}
    ${type === 'stop' ? '<p>O teste tem duas fases. Começa com a prática das respostas e termina com uma fase que inclui o sinal de stop.</p>' : ''}
    ${config.notice ? `<div class="notice stack tight"><h2>Informação do estudo</h2><p class="prose">${e(config.notice)}</p></div>` : ''}
    <form id="participant" class="stack">
      <h2>Identificação do participante</h2>
      <div class="grid-fields">
        <label class="field">Nome<input name="name" required maxlength="120" autocomplete="name"></label>
        <label class="field">Email<input name="email" type="email" required maxlength="254" autocomplete="email"></label>
      </div>
      <p class="meta">O nome e o email serão enviados à equipa de investigação juntamente com as respostas.</p>
      ${config.notice ? '<label class="check"><input type="checkbox" required> Li a informação do estudo.</label>' : ''}
      <p class="error" role="alert" hidden></p>
      <button class="button" type="submit">${type === 'survey' ? 'Abrir questionário' : 'Ver instruções'}</button>
    </form>`);
  const form = app.querySelector('form');
  form.onsubmit = async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.name = data.name.trim();
    data.email = data.email.trim();
    const alert = form.querySelector('.error');
    if (!data.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      return showError(alert, new Error('Introduza o nome e um endereço de email válido.'));
    }
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const start = await api('/api/test/start', { method: 'POST', data: { code } });
      credentials = data;
      attempt = start.attempt;
      if (type === 'survey') survey();
      else instructions(start.plan, 0);
    } catch (error) {
      if ([404, 409].includes(error.status)) unavailable(error);
      else showError(alert, error);
    } finally {
      button.disabled = false;
    }
  };
}

function instructions(plan, position, baselineMean) {
  const { config, type } = test;
  const block = plan[position];
  const base = block.block === 'baseline';
  const goNoGo = type === 'gonogo';
  const progress = goNoGo ? '' : `Fase ${position + 1} de ${plan.length}`;
  const standard = goNoGo
    ? `Responda quando vir «${config.goCue}». Quando vir «${config.noGoCue}», aguarde sem responder.`
    : `Responda à esquerda quando vir «${config.leftCue}» e à direita quando vir «${config.rightCue}». Responda o mais rapidamente possível.` +
      (base ? '' : ` Se a seta for substituída por «${config.stopCue}» antes de responder, aguarde sem responder.`);
  const controls = goNoGo
    ? `Toque ou clique em qualquer ponto da área dos estímulos ou prima ${config.responseKey === 'Space' ? 'a barra de espaços' : keyLabel(config.responseKey)}.`
    : `Para responder à esquerda, toque ou clique na metade esquerda da área dos estímulos ou prima ${keyLabel(config.leftKey)}. Para responder à direita, use a metade direita ou prima ${keyLabel(config.rightKey)}.`;
  const custom = base ? config.baselineInstructions : config.instructions;
  const average = typeof baselineMean === 'number'
    ? `<p class="notice">Tempo médio das respostas corretas na fase inicial: ${fmt(baselineMean)} ms.</p>` : '';
  const title = goNoGo ? 'Instruções do teste' : base ? 'Fase 1 de 2 · Prática das respostas' : 'Fase 1 concluída';
  const nextPhase = !goNoGo && !base ? '<h2>Fase 2 de 2 · Sinal de stop</h2><p>Complete esta fase para enviar as respostas das duas fases.</p>' : '';
  const startText = goNoGo ? 'Iniciar teste' : base ? 'Iniciar fase 1' : 'Continuar para a fase 2';
  screen(title, `
    ${average}${nextPhase}<p class="prose">${e(custom || standard)}</p>
    <p>${e(controls)}</p>
    <p>Após iniciar, mantenha o olhar no centro do ecrã.</p>
    <button class="button" id="begin" type="button">${startText}</button>`, config.title);
  const begin = app.querySelector('#begin');
  begin.focus();
  begin.onclick = async () => {
    screen(goNoGo ? blockNames[block.block] : `${progress} · ${blockNames[block.block]}`, `
      <p class="trial-progress" id="indicator"></p>
      <div class="stage" tabindex="-1" aria-label="Área dos estímulos"><div class="stimulus"></div></div>`, config.title);
    const stage = app.querySelector('.stage');
    stage.focus({ preventScroll: true });
    const indicator = app.querySelector('#indicator');
    const result = await runBlock(type, config, block, stage, indicator);
    responses.push(...result.entries);
    if (position + 1 < plan.length) instructions(plan, position + 1, result.baselineMean);
    else await finish(responses);
  };
}

function questionHtml(question, index) {
  const name = 'q' + index;
  const required = question.required ? 'required' : '';
  const optional = question.required ? '' : ' <span class="meta">(opcional)</span>';
  let input;
  if (question.type === 'text') {
    input = `<label class="field">${e(question.prompt)}${optional}<textarea name="${name}" rows="3" maxlength="2000" ${required}></textarea></label>`;
  } else {
    const values = question.type === 'choice' ? question.options.map((label, value) => ({ label, value }))
      : Array.from({ length: question.max - question.min + 1 }, (_, offset) =>
        ({ value: question.min + offset, label: question.min + offset }));
    input = `<fieldset class="stack tight"><legend>${e(question.prompt)}${optional}</legend>
      ${!question.required ? `<label class="check"><input type="radio" name="${name}" value="" checked> Sem resposta</label>` : ''}
      ${values.map(({ label, value }) => `<label class="check"><input name="${name}" value="${value}" type="radio" ${required}> ${e(label)}</label>`).join('')}</fieldset>`;
  }
  return input;
}

function survey() {
  const { config } = test;
  screen(config.title, `
    ${config.instructions ? `<p class="prose">${e(config.instructions)}</p>` : ''}
    <form class="stack" id="survey">
      ${config.questions.map(questionHtml).join('')}
      <p class="error" role="alert" hidden></p>
      <button class="button" type="submit">Enviar respostas</button>
    </form>`, 'Questionário');
  const form = app.querySelector('form');
  form.onsubmit = async event => {
    event.preventDefault();
    const data = new FormData(form);
    const answers = config.questions.map((question, index) => {
      const value = data.get('q' + index)?.trim();
      return value ? (question.type === 'text' ? value : Number(value)) : null;
    });
    if (config.questions.some((question, index) => question.required && answers[index] === null)) {
      return showError(form.querySelector('.error'), new Error('Preencha as respostas obrigatórias.'));
    }
    await finish(answers);
  };
}

async function finish(answers) {
  screen('A guardar respostas', '<p role="status">Mantenha esta janela aberta até receber a confirmação.</p>');
  try {
    await api('/api/test/submit', {
      method: 'POST', data: { attempt, ...credentials, responses: answers },
    });
    credentials = null;
    attempt = null;
    responses.length = 0;
    const message = test.type === 'stop' ? 'As respostas das duas fases foram guardadas.' : 'As suas respostas foram guardadas.';
    screen('Participação concluída', `<p>${message} Obrigado pela sua participação.</p>`);
  } catch (error) {
    if ([404, 409, 410].includes(error.status)) return unavailable(error);
    screen('Não foi possível guardar as respostas', `<p role="alert" class="error">${e(error.message)}</p>
      <button class="button" id="retry" type="button">Tentar enviar novamente</button>`);
    app.querySelector('#retry').onclick = () => finish(answers);
  }
}

void load();
