import { InputError, string } from './protocol.mjs';

export function score(type, config, plan, entries) {
  if (!Array.isArray(entries)) throw new InputError('Faltam as respostas.');
  if (type === 'survey') {
    if (entries.length !== config.questions.length) throw new InputError('Envie uma resposta por pergunta.');
    return config.questions.map((question, index) => {
      let answer = entries[index];
      if (answer === null && !question.required) return { index, answer };
      if (question.type === 'text') answer = string(answer, 2000, 'a resposta de texto', question.required);
      if (question.type === 'choice' && (!Number.isInteger(answer) || !question.options[answer])) {
        throw new InputError('Selecione uma das respostas disponíveis.');
      }
      if (question.type === 'rating' && (!Number.isInteger(answer) || answer < question.min || answer > question.max)) {
        throw new InputError('Selecione um valor na escala.');
      }
      return { index, answer };
    });
  }

  let position = 0;
  const scored = [];
  for (const { block, trials } of plan) {
    let consecutive = 0;
    for (const trial of trials) {
      const entry = entries[position++];
      if (!entry || entry.block !== block || entry.index !== trial.index) {
        throw new InputError('Os ensaios enviados não correspondem ao teste atribuído.');
      }
      const expected = type === 'gonogo' ? config.responseKey : config[trial.direction === 'left' ? 'leftKey' : 'rightKey'];
      const keys = type === 'gonogo' ? [expected] : [config.leftKey, config.rightKey];
      const { key, rt, cueMs } = entry;
      const responded = key !== null;
      const cueShown = cueMs !== null;
      if ((responded && (!keys.includes(key) || !Number.isFinite(rt) || rt < 0 || rt >= config.windowMs)) ||
          (!responded && rt !== null) ||
          (cueShown && (trial.condition !== 'stop' || !Number.isFinite(cueMs) || cueMs < trial.delay || cueMs >= config.windowMs || (responded && rt < cueMs)))) {
        throw new InputError('Resposta ou medição de tempo inválida.');
      }
      const response = !responded ? 'timeout' : key === expected ? 'correct_key' : 'wrong_key';
      const phase = !responded ? null : trial.condition !== 'stop' ? 'stimulus' : cueShown && rt >= cueMs ? 'after_stop' : 'before_stop';
      let correct = response === 'correct_key';
      if (trial.condition === 'nogo') correct = !responded;
      if (trial.condition === 'stop') correct = cueShown ? !responded : responded && correct;
      const missingStopCue = trial.condition === 'stop' && !responded && !cueShown;
      if (missingStopCue) correct = null;
      scored.push({
        block, ...trial, expected, key, rt, cueMs, response, phase, correct,
        interrupted: entry.interrupted === true || missingStopCue,
      });
      consecutive = correct ? consecutive + 1 : 0;
      if (block === 'baseline' && consecutive >= config.baselineStreak) break;
    }
  }
  if (position !== entries.length) throw new InputError('Foram enviados ensaios adicionais.');
  return scored;
}

function summarizeTimes(values) {
  const count = values.length;
  if (!count) return { count, mean: null, median: null, min: null, max: null };
  values.sort((a, b) => a - b);
  const middle = Math.floor(count / 2);
  return {
    count,
    mean: values.reduce((sum, time) => sum + time, 0) / count,
    median: count % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
    min: values[0],
    max: values[count - 1],
  };
}

function surveySummary(config, submissions) {
  const groups = new Map();
  function collect(questions, results) {
    const occurrences = new Map();
    for (const [index, question] of questions.entries()) {
      const definition = JSON.stringify([question.prompt, question.type, question.options, question.min, question.max]);
      const occurrence = (occurrences.get(definition) || 0) + 1;
      occurrences.set(definition, occurrence);
      const id = definition + ':' + occurrence;
      if (!groups.has(id)) groups.set(id, { question, answers: [], skipped: 0 });
      if (!results) continue;
      const group = groups.get(id);
      const answer = results[index].answer;
      if (answer === null) group.skipped++;
      else group.answers.push(answer);
    }
  }
  collect(config.questions);
  for (const submission of submissions) collect((submission.config ?? config).questions, submission.results);
  return [...groups.values()].map(({ question, answers, skipped }) => {
    const bins = question.type === 'choice' ? question.options : question.type === 'rating'
      ? Array.from({ length: question.max - question.min + 1 }, (_, value) => value + question.min) : [];
    return {
      label: question.prompt, count: answers.length, skipped,
      distribution: bins.map((label, bin) => ({
        label, count: answers.filter(answer => answer === (question.type === 'choice' ? bin : label)).length,
      })),
    };
  });
}

export function describe(type, config, submissions) {
  if (type === 'survey') return surveySummary(config, submissions);

  const groups = new Map();
  for (const submission of submissions) {
    for (const result of submission.results) {
      const id = `${result.block}:${result.condition}`;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(result);
    }
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, rows]) => {
    const timed = rows.filter(row => Number.isFinite(row.rt));
    const correctTimes = summarizeTimes(timed.filter(row => row.correct === true).map(row => row.rt));
    const hits = rows.filter(row => row.correct === true).length;
    const errors = rows.filter(row => row.correct === false).length;
    return {
      accuracy: hits + errors ? hits / (hits + errors) : null,
      block: rows[0].block, condition: rows[0].condition, count: rows.length,
      correct: hits, errors,
      timeouts: rows.filter(row => row.response === 'timeout').length,
      interrupted: rows.filter(row => row.interrupted).length,
      mean: correctTimes.mean, median: correctTimes.median,
      correctTimes, allTimes: summarizeTimes(timed.map(row => row.rt)),
    };
  });
}

function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let text = String(value);
  if (typeof value === 'string' && /^[\s\uFEFF]*[=+@\-\t\r\n]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

function csvLines(lines) {
  return '\uFEFF' + lines.map(line => line.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function timingCsv(stats) {
  const fields = ['count', 'mean', 'median', 'min', 'max'];
  const columns = prefix => fields.map(field => prefix + '_' + field + (field === 'count' ? '' : '_ms'));
  const lines = [[
    'block', 'condition', 'trial_count', 'no_key_count',
    ...columns('all_responses'), ...columns('correct_responses'),
  ]];
  for (const { block, condition, count, timeouts, allTimes, correctTimes } of stats) {
    lines.push([block, condition, count, timeouts,
      ...fields.map(field => allTimes[field]), ...fields.map(field => correctTimes[field])]);
  }
  return csvLines(lines);
}

export function csv(type, config, submissions) {
  const common = ['participant_id', 'completed_at_utc'];
  const stop = type === 'stop';
  const columns = type === 'survey'
    ? ['question_index', 'question', 'question_type', 'answer', 'answer_index']
    : ['block', 'trial', 'condition', ...(stop ? ['direction', 'stop_delay_ms', 'observed_stop_delay_ms'] : []),
       'expected_key', 'key', 'rt_ms', 'response', ...(stop ? ['phase'] : []),
       'correct', 'timing_flag', 'response_window_ms'];
  const lines = [[...common, ...columns]];
  for (const submission of submissions) {
    const prefix = [submission.id, submission.completedAt];
    const givenConfig = submission.config ?? config;
    for (const row of submission.results) {
      if (type === 'survey') {
        const question = givenConfig.questions[row.index];
        const choice = question.type === 'choice' && row.answer !== null;
        lines.push([...prefix, row.index + 1, question.prompt, question.type,
          choice ? question.options[row.answer] : row.answer, choice ? row.answer + 1 : null]);
      } else {
        lines.push([...prefix, row.block, row.index + 1, row.condition, ...(stop ? [row.direction, row.delay, row.cueMs] : []),
          row.expected, row.key, row.rt, row.response, ...(stop ? [row.phase] : []), row.correct === null ? null : Number(row.correct),
          Number(row.interrupted), givenConfig.windowMs]);
      }
    }
  }
  return csvLines(lines);
}
