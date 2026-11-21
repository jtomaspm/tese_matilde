import { randomInt } from 'node:crypto';

export const types = {
  gonogo: 'Go / No-Go',
  stop: 'Sinal de stop',
  survey: 'Questionário',
};

const common = { description: '', notice: '', instructions: '' };
export const defaults = {
  gonogo: {
    ...common, title: 'Go / No-Go', description: 'Teste que regista respostas a dois estímulos visuais.',
    goCount: 20, noGoCount: 5, windowMs: 2000, gapMs: 500, feedbackMs: 2000,
    goCue: 'VAI', noGoCue: 'PARA', responseKey: 'Space',
  },
  stop: {
    ...common, title: 'Sinal de stop', description: 'Teste que regista respostas direcionais e respostas a um sinal de stop.',
    baselineInstructions: '', baselineStreak: 20, baselineLimit: 50,
    goCount: 30, noGoCount: 10, windowMs: 500, gapMs: 750, frameMs: 500,
    stopMin: 100, stopMax: 450, stopStep: 50, leftKey: 'b', rightKey: 'n',
    leftCue: '←', rightCue: '→', stopCue: 'PARA',
  },
  survey: { ...common, title: '', questions: [] },
};

export class InputError extends Error {}

export function string(value, max, name, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    throw new InputError(`Verifique ${name}.`);
  }
  return value.trim();
}

function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new InputError(`${label} deve estar entre ${min} e ${max}.`);
  }
  return value;
}

export function validateConfig(type, source) {
  if (!Object.hasOwn(types, type) || !source || typeof source !== 'object') {
    throw new InputError('Escolha um tipo de teste disponível.');
  }
  const config = {
    title: string(source.title, 100, 'o título', true),
    description: string(source.description, 1000, 'a descrição'),
    notice: string(source.notice, 6000, 'a informação aos participantes'),
    instructions: string(source.instructions, 3000, 'as instruções'),
  };
  if (type === 'survey') {
    if (!Array.isArray(source.questions) || !source.questions.length || source.questions.length > 60) {
      throw new InputError('Adicione entre 1 e 60 perguntas.');
    }
    config.questions = source.questions.map((q, index) => {
      if (!q || !['choice', 'rating', 'text'].includes(q.type)) throw new InputError('Escolha um formato de pergunta.');
      const question = { prompt: string(q.prompt, 500, `a pergunta ${index + 1}`, true), type: q.type, required: q.required === true };
      if (q.type === 'choice') {
        if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 20) {
          throw new InputError('Adicione entre 2 e 20 opções.');
        }
        question.options = q.options.map(option => string(option, 160, 'a opção de resposta', true));
        if (new Set(question.options).size !== question.options.length) throw new InputError('Use opções de resposta diferentes.');
      }
      if (q.type === 'rating') {
        question.min = integer(q.min, 0, 10, 'O mínimo da escala');
        question.max = integer(q.max, question.min + 1, 10, 'O máximo da escala');
      }
      return question;
    });
    return config;
  }

  Object.assign(config, {
    goCount: integer(source.goCount, 1, 200, 'O número de ensaios Go'),
    noGoCount: integer(source.noGoCount, 0, 100, 'O número de ensaios de inibição'),
    windowMs: integer(source.windowMs, 100, 10000, 'A janela de resposta'),
    gapMs: integer(source.gapMs, 0, 10000, 'O intervalo entre ensaios'),
  });
  if (type === 'gonogo') {
    return {
      ...config, goCue: string(source.goCue, 40, 'o estímulo Go', true),
      noGoCue: string(source.noGoCue, 40, 'o estímulo No-Go', true),
      feedbackMs: integer(source.feedbackMs, 0, 5000, 'A duração do feedback'),
      responseKey: key(source.responseKey, true),
    };
  }

  const stopMin = integer(source.stopMin, 1, config.windowMs - 1, 'O atraso mínimo do sinal');
  const stopMax = integer(source.stopMax, stopMin, config.windowMs - 1, 'O atraso máximo do sinal');
  const stopStep = integer(source.stopStep, 1, 2000, 'O incremento do atraso');
  if ((stopMax - stopMin) % stopStep !== 0) throw new InputError('O intervalo de atrasos deve ser divisível pelo incremento.');
  const baselineStreak = integer(source.baselineStreak, 1, 100, 'O número de respostas iniciais consecutivas');
  const leftKey = key(source.leftKey);
  const rightKey = key(source.rightKey);
  if (leftKey === rightKey) throw new InputError('Escolha duas teclas diferentes.');
  return {
    ...config, baselineStreak, baselineLimit: integer(source.baselineLimit, baselineStreak, 200, 'O limite de ensaios iniciais'),
    baselineInstructions: string(source.baselineInstructions, 3000, 'as instruções da fase inicial'),
    frameMs: integer(source.frameMs, 0, 5000, 'A duração da preparação'),
    stopMin, stopMax, stopStep, leftKey, rightKey,
    leftCue: string(source.leftCue, 40, 'o estímulo esquerdo', true),
    rightCue: string(source.rightCue, 40, 'o estímulo direito', true),
    stopCue: string(source.stopCue, 40, 'o sinal de stop', true),
  };
}

function key(value, allowSpace = false) {
  if (allowSpace && value === 'Space') return value;
  if (typeof value !== 'string' || !/^[a-z0-9]$/i.test(value)) {
    throw new InputError('Use uma letra ou um algarismo, ou Space para Go / No-Go.');
  }
  return value.toLowerCase();
}

function shuffle(items) {
  for (let index = items.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [items[index], items[other]] = [items[other], items[index]];
  }
  return items;
}

export function makePlan(type, config) {
  if (type === 'survey') return [];
  const conditions = shuffle([...Array(config.goCount).fill('go'), ...Array(config.noGoCount).fill(type === 'stop' ? 'stop' : 'nogo')]);
  const trial = (condition, index) => ({
    index, condition,
    direction: type === 'stop' ? ['left', 'right'][randomInt(2)] : null,
    delay: condition === 'stop'
      ? config.stopMin + config.stopStep * randomInt((config.stopMax - config.stopMin) / config.stopStep + 1)
      : null,
  });
  if (type === 'gonogo') return [{ block: 'training', trials: conditions.map(trial) }];
  return [
    { block: 'baseline', trials: Array.from({ length: config.baselineLimit }, (_, index) => trial('go', index)) },
    { block: 'stopgo', trials: conditions.map(trial) },
  ];
}
