import { api, escape as e, showError, blockNames, conditionNames, fmt } from './ui.js';

const app = document.querySelector('#app');
const account = document.querySelector('#account');
const accountTrigger = account.querySelector('summary');
const logout = document.querySelector('#logout');
const passwordDialog = document.querySelector('#password-dialog');
const passwordForm = passwordDialog.querySelector('form');
const passwordError = passwordForm.querySelector('.error');
const toast = document.querySelector('#toast');
const toastMessage = document.querySelector('#toast-message');
const manualInvite = document.querySelector('#manual-invite');
const manualLink = manualInvite.querySelector('input');
let library;
let activeId;
let detailRequest = 0;
let toastTimer;

function hideToast() {
  clearTimeout(toastTimer);
  toast.hidden = true;
  toastMessage.textContent = '';
  manualLink.value = '';
}

function notify(message, link = '') {
  clearTimeout(toastTimer);
  manualInvite.hidden = !link;
  manualLink.value = link;
  toast.hidden = false;
  toastMessage.textContent = message;
  toastTimer = setTimeout(hideToast, link ? 30000 : 5000);
}

async function fail(error) {
  if (error.status === 401) {
    await initialize();
    notify('A sessão terminou. Inicie sessão novamente.');
  } else notify(error.message);
}

async function initialize() {
  try {
    const session = await api('/api/admin/session');
    if (session.authenticated) return await dashboard();
    account.open = false;
    account.hidden = true;
    hideToast();
    const setup = session.setup;
    app.innerHTML = `
      <section class="narrow panel stack">
        <p class="eyebrow">Área de investigação</p>
        <h1>${setup ? 'Configurar acesso' : 'Iniciar sessão'}</h1>
        <p>${setup ? 'Defina a palavra-passe da área de investigação.' : 'Aceda aos testes, convites e resultados dos estudos.'}</p>
        <form class="stack" id="auth">
          ${setup && session.setupTokenRequired ? '<label class="field">Código de configuração<input name="setupToken" type="password" required></label>' : ''}
          <label class="field">Palavra-passe
            <input name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" maxlength="256" required>
          </label>
          ${setup ? '<label class="field">Confirmar palavra-passe<input name="confirmation" type="password" autocomplete="new-password" required></label>' : ''}
          <p class="error" role="alert" hidden></p>
          <button class="button" type="submit">${setup ? 'Guardar e entrar' : 'Entrar'}</button>
        </form>
      </section>`;
    const form = app.querySelector('form');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      const error = form.querySelector('.error');
      if (setup && data.password !== data.confirmation) {
        return showError(error, new Error('As palavras-passe devem ser iguais.'));
      }
      delete data.confirmation;
      const submit = form.querySelector('button');
      submit.disabled = true;
      try {
        await api('/api/admin/' + (setup ? 'setup' : 'login'), { method: 'POST', data });
        await dashboard();
      } catch (failure) {
        if (failure.status === 409) await initialize();
        else showError(error, failure);
      } finally { submit.disabled = false; }
    });
  } catch (error) {
    app.innerHTML = `<section class="panel narrow stack"><h1>Área de investigação</h1><p class="error">${e(error.message)}</p><button class="button secondary" id="retry">Tentar novamente</button></section>`;
    app.querySelector('#retry').onclick = initialize;
  }
}

logout.onclick = async () => {
  account.open = false;
  accountTrigger.focus();
  try {
    await api('/api/admin/logout', { method: 'POST', data: {} });
    activeId = null;
    await initialize();
  } catch (error) { await fail(error); }
};

document.addEventListener('click', event => {
  if (!account.contains(event.target)) account.open = false;
});
window.addEventListener('resize', () => app.querySelector('.test-menu-popover:popover-open')?.hidePopover());
account.addEventListener('keydown', event => {
  if (event.key === 'Escape' && account.open) {
    account.open = false;
    accountTrigger.focus();
  }
});

document.querySelector('#change-password').onclick = () => {
  account.open = false;
  accountTrigger.focus();
  passwordDialog.showModal();
};
document.querySelector('#cancel-password').onclick = () => passwordDialog.close();
passwordDialog.addEventListener('close', () => {
  passwordForm.reset();
  showError(passwordError);
});
passwordDialog.addEventListener('cancel', event => {
  if (passwordForm.querySelector('[type="submit"]').disabled) event.preventDefault();
});
passwordForm.onsubmit = async event => {
  event.preventDefault();
  const { currentPassword, newPassword, confirmation } = Object.fromEntries(new FormData(passwordForm));
  if (newPassword !== confirmation) {
    return showError(passwordError, new Error('As novas palavras-passe devem ser iguais.'));
  }
  const submit = passwordForm.querySelector('[type="submit"]');
  const cancel = document.querySelector('#cancel-password');
  submit.disabled = true;
  cancel.disabled = true;
  showError(passwordError);
  try {
    await api('/api/admin/password', { method: 'POST', data: { currentPassword, newPassword } });
    passwordDialog.close();
    notify('Palavra-passe alterada.');
  } catch (error) {
    if (error.status === 401) {
      passwordDialog.close();
      await fail(error);
    } else showError(passwordError, error);
  } finally {
    submit.disabled = false;
    cancel.disabled = false;
  }
};

async function dashboard(id = activeId) {
  library = await api('/api/admin/tests');
  account.hidden = false;
  app.innerHTML = `
    <div class="dashboard">
      <aside class="sidebar" aria-labelledby="library-title">
        <div class="library-header">
          <h1 id="library-title">Biblioteca de testes</h1>
          <button type="button" class="button compact library-create" id="new-test"><span aria-hidden="true">+</span> Criar teste</button>
        </div>
        <div id="test-list" class="test-list" role="region" aria-labelledby="library-title" tabindex="0"></div>
      </aside>
      <div id="test-detail" class="detail" role="region" aria-label="Detalhes do teste"></div>
    </div>`;
  app.querySelector('#new-test').onclick = () => editor();
  const list = app.querySelector('#test-list');
  list.innerHTML = library.tests.map(test => `
    <div class="test-row">
      <button class="test-picker" data-id="${test.id}" type="button">${e(test.config.title)}</button>
      <button class="test-menu-trigger" type="button" popovertarget="test-menu-${test.id}" aria-label="Opções de ${e(test.config.title)}"><span aria-hidden="true">⋯</span></button>
      <div class="dropdown-options test-menu-popover" id="test-menu-${test.id}" data-test="${test.id}" popover>
        <button type="button" data-action="edit">Editar</button>
        <button type="button" data-action="delete" class="danger">Eliminar</button>
      </div>
    </div>`).join('') || '<p class="meta">Ainda não existem testes.</p>';
  list.onclick = async event => {
    const item = event.target.closest('button');
    if (item?.dataset.id) return selectTest(Number(item.dataset.id));
    if (!item?.dataset.action) return;
    const menu = item.closest('.test-menu-popover');
    const test = library.tests.find(test => test.id === Number(menu.dataset.test));
    menu.hidePopover();
    if (item.dataset.action === 'edit') return editor(test);
    if (!confirm(`Eliminar «${test.config.title}»? Os convites deste teste deixarão de funcionar.`)) return;
    try {
      await api(`/api/admin/tests/${test.id}`, { method: 'DELETE' });
      await dashboard();
      notify('Teste eliminado.');
    } catch (error) { await fail(error); }
  };
  list.addEventListener('beforetoggle', event => {
    const menu = event.target;
    if (event.newState !== 'open' || !menu.classList.contains('test-menu-popover')) return;
    const trigger = menu.previousElementSibling.getBoundingClientRect();
    menu.style.top = `${trigger.bottom + 6}px`;
    menu.style.right = `${Math.max(8, document.documentElement.clientWidth - trigger.right)}px`;
  }, true);
  list.addEventListener('toggle', event => {
    const menu = event.target;
    if (event.newState !== 'open' || !menu.classList.contains('test-menu-popover')) return;
    const bounds = menu.getBoundingClientRect();
    if (bounds.bottom > window.innerHeight - 8) {
      menu.style.top = `${Math.max(8, menu.previousElementSibling.getBoundingClientRect().top - bounds.height - 6)}px`;
    }
  }, true);
  list.addEventListener('scroll', () => list.querySelector('.test-menu-popover:popover-open')?.hidePopover());
  const selected = library.tests.find(test => test.id === id) || library.tests[0];
  if (selected) await selectTest(selected.id);
  else {
    activeId = null;
    app.querySelector('#test-detail').innerHTML = '<section class="panel stack"><h2>Resultados dos estudos</h2><p>Crie o primeiro teste para começar a recolher respostas.</p></section>';
  }
}

async function selectTest(id) {
  activeId = id;
  for (const button of app.querySelectorAll('.test-picker')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.id) === id));
  }
  const detail = app.querySelector('#test-detail');
  const request = ++detailRequest;
  window.scrollTo(0, 0);
  detail.innerHTML = '<p role="status">A carregar o teste…</p>';
  try {
    const data = await api(`/api/admin/tests/${id}`);
    if (request !== detailRequest || !detail.isConnected) return;
    renderDetail(detail, data);
  } catch (error) {
    if (request !== detailRequest || !detail.isConnected) return;
    detail.innerHTML = `<div class="stack"><p class="error">${e(error.message)}</p><button class="button secondary" type="button">Tentar novamente</button></div>`;
    detail.querySelector('button').onclick = () => selectTest(id);
    await fail(error);
  }
}

const dates = new Intl.DateTimeFormat('pt-PT', { dateStyle: 'short', timeStyle: 'short' });
const date = value => dates.format(new Date(value));
const millis = value => value === null ? '—' : fmt(value) + ' ms';
const linkFor = code => new URL('/test?code=' + code, location.origin).href;

function resultsHtml(test, stats, total) {
  if (!total) return '<p>Ainda não há respostas concluídas.</p>';
  if (test.type === 'survey') return stats.map(question => `
    <div class="stack tight">
      <h3>${e(question.label)}</h3>
      <p>${question.count} respostas · ${question.skipped} em branco</p>
      ${question.distribution.length ? `<div class="table-scroll"><table aria-label="${e(question.label)}"><thead><tr><th>Resposta</th><th>Frequência</th></tr></thead>
      <tbody>${question.distribution.map(bin => `<tr><td>${e(bin.label)}</td><td><meter min="0" max="${Math.max(1, question.count)}" value="${bin.count}" aria-hidden="true"></meter> ${bin.count}</td></tr>`).join('')}</tbody></table></div>`
        : '<p>Consulte as respostas de texto no separador Participantes.</p>'}
    </div>`).join('');
  return `
    <h3>Acerto por condição</h3>
    <div class="rate-list">${stats.map(row => `<div><span>${e(blockNames[row.block])} · ${e(conditionNames[row.condition])}</span><meter aria-label="Taxa de acerto" min="0" max="1" value="${row.accuracy ?? 0}"></meter><strong>${row.accuracy === null ? '—' : fmt(row.accuracy * 100) + '%'}</strong></div>`).join('')}</div>
    <div class="table-scroll"><table aria-label="Estatísticas por condição">
    <thead><tr><th>Fase</th><th>Condição</th><th>Ensaios</th><th>Corretos</th><th>Erros</th><th>Acerto</th><th>Sem tecla</th><th>Sinalizados</th></tr></thead>
    <tbody>${stats.map(row => `<tr><td>${blockNames[row.block]}</td><td>${conditionNames[row.condition]}</td><td>${row.count}</td>
      <td>${row.correct}</td><td>${row.errors}</td><td>${row.accuracy === null ? '—' : fmt(100 * row.accuracy) + '%'}</td><td>${row.timeouts}</td><td>${row.interrupted}</td></tr>`).join('')}</tbody>
    </table></div>
    <h3>Tempos de reação</h3>
    <p>Os tempos são medidos desde o estímulo inicial até à tecla premida. Os ensaios sem tecla ficam sem tempo de reação.</p>
    <div class="table-scroll"><table aria-label="Tempos de reação por condição">
    <thead><tr><th>Fase</th><th>Condição</th><th>Respostas</th><th>Com tempo</th><th>Média</th><th>Mediana</th><th>Mínimo</th><th>Máximo</th></tr></thead>
    <tbody>${stats.flatMap(row => [['Todas', row.allTimes], ['Corretas', row.correctTimes]].map(([label, times]) => `
      <tr><td>${blockNames[row.block]}</td><td>${conditionNames[row.condition]}</td><td>${label}</td><td>${times.count}</td>
      <td>${millis(times.mean)}</td><td>${millis(times.median)}</td><td>${millis(times.min)}</td><td>${millis(times.max)}</td></tr>`)).join('')}</tbody>
    </table></div>`;
}

function inviteTable(invites) {
  return invites.length ? `<div class="table-scroll"><table class="invite-table" aria-label="Convites">
        <thead><tr><th>Referência</th><th>Criado em</th><th>Participações</th><th>Estado</th><th>Ações</th></tr></thead>
        <tbody>${invites.map(item => `
          <tr><td class="invite-reference" title="${e(item.label)}">${e(item.label || '—')}</td><td>${e(date(item.createdAt))}</td><td>${fmt(item.completed)}</td>
            <td><span class="badge ${item.revoked ? 'muted' : ''}">${item.revoked ? 'Desativado' : 'Disponível'}</span></td>
            <td>${item.revoked ? '—' : `<div class="invite-actions">
              <button class="invite-action" type="button" aria-label="Copiar ligação" data-copy="${e(item.code)}">Copiar</button>
              <button class="invite-action danger" type="button" data-revoke="${e(item.code)}">Desativar</button>
            </div>`}</td></tr>`).join('')}</tbody></table></div>` : '<p>Ainda não existem convites para este teste.</p>';
}

function resultsPanel(test, { stats, mixedConfigs, completed }) {
  const path = `/api/admin/tests/${test.id}`;
  return `
    <div class="row"><h3>Resumo das respostas</h3><div class="actions result-actions">
      <a class="button secondary compact" href="${path}/csv">${test.type === 'survey' ? 'Descarregar CSV' : 'CSV por ensaio'}</a>
      ${test.type === 'survey' ? '' : `<a class="button secondary compact" href="${path}/timing-csv">CSV de tempos</a>`}
    </div>
    </div>
    ${mixedConfigs ? '<p class="notice">Estes resultados incluem respostas de convites com configurações diferentes.</p>' : ''}
    ${resultsHtml(test, stats, completed)}`;
}

function participantsPanel(participants) {
  if (!participants.length) return '<p>Ainda não há participantes com respostas concluídas.</p>';
  return `
    <label class="field participant-search">Procurar participante<input type="search" placeholder="Nome, email ou referência"></label>
    <div class="table-scroll"><table aria-label="Participantes"><thead><tr><th>Participante</th><th>Referência</th><th>Conclusão</th></tr></thead>
    <tbody>${participants.map(person => `<tr><td><button class="person-link" data-person="${e(person.id)}">${e(person.name)}</button><small>${e(person.email)}</small></td>
      <td>${e(person.label || '—')}</td><td>${e(date(person.completedAt))}</td></tr>`).join('')}</tbody></table></div>
    <p data-empty hidden>Sem participantes correspondentes.</p>`;
}

function individualResults(type, person) {
  const { config, results } = person;
  const table = type === 'survey' ? `<dl class="answers">${results.map(({ index, answer }) => {
    const q = config.questions[index];
    return `<div><dt>${e(q.prompt)}</dt><dd class="prose">${answer === null ? 'Sem resposta' : e(q.type === 'choice' ? q.options[answer] : answer)}</dd></div>`;
  }).join('')}</dl>` : `<div class="table-scroll"><table><caption>Resultados por ensaio</caption><thead><tr><th>Fase</th><th>Ensaio</th><th>Condição</th><th>Tecla</th><th>Acerto</th><th>Tempo de reação</th><th>Sinalizado</th></tr></thead><tbody>
    ${results.map(r => `<tr><td>${e(blockNames[r.block])}</td><td>${r.index + 1}</td><td>${e(conditionNames[r.condition])}</td><td>${e(r.key ?? '—')}</td><td>${r.correct === null ? 'Indeterminado' : r.correct ? 'Sim' : 'Não'}</td><td>${millis(r.rt)}</td><td>${r.interrupted ? 'Sim' : 'Não'}</td></tr>`).join('')}
    </tbody></table></div>`;
  return `<button class="button secondary compact" data-back>← Participantes</button>
    <h3 tabindex="-1">${e(person.name)}</h3><p>${e(person.email)} · ${e(date(person.completedAt))}</p>
    <p class="meta">Identificador · ${e(person.id)}${person.label ? ' · ' + e(person.label) : ''}</p>${table}`;
}

const testTabs = { results: 'Resultados', participants: 'Participantes', invitations: 'Convites' };

function renderDetail(detail, { test, counts }) {
  const path = `/api/admin/tests/${test.id}`;
  detail.innerHTML = `
    <section aria-labelledby="test-title">
      <header class="test-overview">
        <div class="overview-top">
          <div class="overview-heading">
            <p class="eyebrow">Painel de resultados · ${e(library.types[test.type])}</p>
            <h2 id="test-title">${e(test.config.title)}</h2>
            ${test.config.description ? `<p class="prose">${e(test.config.description)}</p>` : ''}
          </div>

        </div>
        <dl class="metrics">
          <div class="metric"><dt>Testes concluídos</dt><dd id="completed-tests">${fmt(counts.completed)}</dd></div>
          <div class="metric"><dt>Convites disponíveis</dt><dd id="available-invites">${fmt(counts.availableInvites)}</dd></div>
          <div class="metric"><dt>Convites criados</dt><dd id="created-invites">${fmt(counts.totalInvites)}</dd></div>
        </dl>
      </header>
      <div class="detail-tabs" role="tablist" aria-label="Detalhes do teste">
        ${Object.entries(testTabs).map(([key, title]) =>
          `<button type="button" id="tab-${key}" role="tab" aria-controls="panel-${key}" aria-selected="false" tabindex="-1">${title}</button>`).join('')}
      </div>
      <div class="detail-tab-panel stack" id="panel-invitations" role="tabpanel" aria-labelledby="tab-invitations" tabindex="0" hidden>
                  <form class="invite-form" id="invite-form" aria-label="Gerar convite">
            <label class="field">Referência<input name="label" maxlength="100" required></label>
            <button type="submit" class="button">Gerar ligação</button>
          </form>
        <p>Pode partilhar a mesma ligação com todos os participantes. Use a referência «Website» para publicar a ligação no menu Testes.</p>
        <div id="invite-list" class="stack"><p role="status">A carregar os convites…</p></div>
        <nav class="invite-pagination" aria-label="Paginação dos convites" hidden>
          <p class="meta" id="invite-page-status" role="status"></p>
          <div class="actions">
            <button type="button" class="button secondary compact" id="previous-invite-page">Anterior</button>
            <button type="button" class="button secondary compact" id="next-invite-page">Seguinte</button>
          </div>
        </nav>
      </div>
      ${['results', 'participants'].map(key =>
        `<div class="detail-tab-panel stack" id="panel-${key}" role="tabpanel" aria-labelledby="tab-${key}" tabindex="0" hidden></div>`).join('')}
    </section>`;

  const tabs = [...detail.querySelectorAll('[role="tab"]')];
  const panels = tabs.map(tab => detail.querySelector('#' + tab.getAttribute('aria-controls')));
  const form = detail.querySelector('#invite-form');
  const inviteList = detail.querySelector('#invite-list');
  const pagination = detail.querySelector('.invite-pagination');
  const pageStatus = detail.querySelector('#invite-page-status');
  const previous = detail.querySelector('#previous-invite-page');
  const next = detail.querySelector('#next-invite-page');
  const stillOpen = () => form.isConnected;
  let invitePage = 1;
  let inviteRequest = 0;
  let tabRequest = 0;

  function updateCounts(counts) {
    detail.querySelector('#completed-tests').textContent = fmt(counts.completed);
    detail.querySelector('#available-invites').textContent = fmt(counts.availableInvites);
    detail.querySelector('#created-invites').textContent = fmt(counts.totalInvites);
  }

  function showRetry(region, error, retry) {
    region.innerHTML = `<p class="error" role="alert">${e(error.message)}</p><button class="button secondary compact" type="button">Tentar novamente</button>`;
    region.querySelector('button').onclick = retry;
    if (error.status === 401) void fail(error);
  }

  async function loadInvitations(page) {
    const request = ++inviteRequest;
    inviteList.setAttribute('aria-busy', 'true');
    try {
      const data = await api(`${path}/invitations?page=${page}`);
      if (!stillOpen() || request !== inviteRequest) return;
      invitePage = data.page;
      inviteList.innerHTML = inviteTable(data.invites);
      pagination.hidden = data.totalPages <= 1;
      pageStatus.textContent = `Página ${fmt(data.page)} de ${fmt(data.totalPages)}`;
      previous.disabled = data.page <= 1;
      next.disabled = data.page >= data.totalPages;
      updateCounts(data);
    } catch (error) {
      if (!stillOpen() || request !== inviteRequest) return;
      pagination.hidden = true;
      showRetry(inviteList, error, () => loadInvitations(page));
    } finally {
      if (request === inviteRequest) inviteList.removeAttribute('aria-busy');
    }
  }

  async function selectTab(index) {
    for (const [position, tab] of tabs.entries()) {
      const selected = position === index;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels[position].hidden = !selected;
    }
    const request = ++tabRequest;
    const section = Object.keys(testTabs)[index];
    if (section === 'invitations') return loadInvitations(invitePage);
    const panel = panels[index];

    panel.innerHTML = '<p role="status">A carregar…</p>';
    try {
      const data = await api(`${path}/${section}`);
      if (!stillOpen() || request !== tabRequest) return;
      if (data.counts) updateCounts(data.counts);
      panel.innerHTML = section === 'results' ? resultsPanel(test, data) : participantsPanel(data.participants);
      if (section === 'participants' && data.participants.length) {
        const search = panel.querySelector('input');
        search.oninput = () => {
          const rows = [...panel.querySelectorAll('tbody tr')];
          rows.forEach(row => { row.hidden = !row.textContent.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()); });
          panel.querySelector('[data-empty]').hidden = rows.some(row => !row.hidden);
        };
        panel.onclick = async event => {
          const button = event.target.closest('[data-person]');
          if (!button) return;
          const current = ++tabRequest;
          try {
            const person = await api(`${path}/participants?id=${encodeURIComponent(button.dataset.person)}`);
            if (!stillOpen() || current !== tabRequest) return;
            panel.innerHTML = individualResults(test.type, person);
            panel.querySelector('h3').focus();
            panel.querySelector('[data-back]').onclick = async () => {
              await selectTab(index);
              const filter = panel.querySelector('input');
              if (filter) { filter.value = search.value; filter.oninput(); }
              panel.querySelector(`[data-person="${CSS.escape(person.id)}"]`)?.focus();
            };
          } catch (error) { if (stillOpen() && current === tabRequest) await fail(error); }
        };
      }
    } catch (error) {
      if (stillOpen() && request === tabRequest) showRetry(panel, error, () => selectTab(index));
    }
  }

  tabs.forEach((tab, index) => {
    tab.onclick = () => selectTab(index);
    tab.onkeydown = event => {
      const positions = {
        ArrowLeft: (index + tabs.length - 1) % tabs.length,
        ArrowRight: (index + 1) % tabs.length,
        Home: 0, End: tabs.length - 1,
      };
      if (!Object.hasOwn(positions, event.key)) return;
      event.preventDefault();
      const position = positions[event.key];
      void selectTab(position);
      tabs[position].focus();
    };
  });
  previous.onclick = () => loadInvitations(invitePage - 1);
  next.onclick = () => loadInvitations(invitePage + 1);

  form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    const label = form.elements.label.value.trim();
    const pending = api(`${path}/invitations`, { method: 'POST', data: { label } });
    const clipboard = copyPendingInvitation(pending);
    button.disabled = true;
    try {
      const invite = await pending;
      const link = linkFor(invite.code);
      let refresh;
      if (stillOpen()) {
        form.reset();
        refresh = loadInvitations(1);
      }
      const copied = await clipboard || await copyLink(link);
      notifyInvitation(link, copied);
      await refresh;
    } catch (error) { await fail(error); }
    finally { button.disabled = false; }
  };

  inviteList.onclick = async event => {
    const button = event.target.closest('button');
    if (button?.dataset.copy) {
      const link = linkFor(button.dataset.copy);
      notifyInvitation(link, await copyLink(link));
    }
    if (button?.dataset.revoke && confirm('Desativar este convite?')) {
      button.disabled = true;
      try {
        await api('/api/admin/invitations/' + button.dataset.revoke + '/revoke', { method: 'POST', data: {} });
        if (stillOpen()) await loadInvitations(invitePage);
      } catch (error) { await fail(error); }
      finally { button.disabled = false; }
    }
  };

  void selectTab(0);
}

function copyPendingInvitation(pending) {
  if (!navigator.clipboard?.write || !window.ClipboardItem) return Promise.resolve(false);

  // Start the clipboard write during the form gesture while the server generates the link.
  const content = pending.then(({ code }) => new Blob([linkFor(code)], { type: 'text/plain' }));
  content.catch(() => {});
  try {
    return navigator.clipboard.write([new ClipboardItem({ 'text/plain': content })]).then(() => true, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

async function copyLink(link) {
  try {
    await navigator.clipboard.writeText(link);
    return true;
  } catch {
    return false;
  }
}

function notifyInvitation(link, copied) {
  if (account.hidden) return;
  if (copied) notify('Ligação copiada para a área de transferência.');
  else notify('O navegador bloqueou a cópia automática. Pode copiar a ligação abaixo.', link);
}

const taskFields = {
  gonogo: [
    ['goCue', 'Estímulo Go'], ['noGoCue', 'Estímulo No-Go'], ['responseKey', 'Tecla (Space ou uma letra/algarismo)'],
    ['goCount', 'Ensaios Go', 1, 200], ['noGoCount', 'Ensaios No-Go', 0, 100], ['windowMs', 'Janela de resposta (ms)', 100, 10000],
    ['gapMs', 'Intervalo entre ensaios (ms)', 0, 10000], ['feedbackMs', 'Duração do feedback de erro (ms)', 0, 5000],
  ],
  stop: [
    ['leftCue', 'Estímulo esquerdo'], ['rightCue', 'Estímulo direito'], ['stopCue', 'Sinal de stop'],
    ['leftKey', 'Tecla esquerda'], ['rightKey', 'Tecla direita'],
    ['baselineStreak', 'Acertos consecutivos na fase inicial', 1, 100], ['baselineLimit', 'Máximo de ensaios na fase inicial', 1, 200],
    ['goCount', 'Ensaios Go na segunda fase', 1, 200], ['noGoCount', 'Ensaios de stop', 0, 100],
    ['windowMs', 'Janela de resposta (ms)', 100, 10000], ['frameMs', 'Preparação antes da fixação (ms)', 0, 5000],
    ['gapMs', 'Intervalo entre ensaios (ms)', 0, 10000],
    ['stopMin', 'Atraso mínimo do sinal (ms)', 1, 9999], ['stopMax', 'Atraso máximo do sinal (ms)', 1, 9999],
    ['stopStep', 'Incremento do atraso (ms)', 1, 2000],
  ],
};
const field = (name, label, value, max, required = false) =>
  `<label class="field">${label}<input name="${name}" maxlength="${max}" value="${e(value)}" ${required ? 'required' : ''}></label>`;
const textarea = (name, label, value, max, hint = '') =>
  `<label class="field">${label}${hint ? `<small>${hint}</small>` : ''}<textarea name="${name}" rows="3" maxlength="${max}">${e(value)}</textarea></label>`;
const numberInput = (name, label, value, min, max) =>
  `<label class="field">${label}<input type="number" name="${name}" min="${min}" max="${max}" value="${e(value)}" step="1" required></label>`;
const questionTypes = { choice: 'Escolha única', rating: 'Escala numérica', text: 'Resposta aberta' };

function editor(existing) {
  ++detailRequest;
  window.scrollTo(0, 0);
  let type = existing?.type || 'gonogo';
  let config = structuredClone(existing?.config || library.defaults[type]);
  app.innerHTML = `
    <div class="view-head"><div><p class="eyebrow">Configuração</p><h1>${existing ? 'Editar teste' : 'Criar teste'}</h1></div>
      <button class="button secondary" id="back" type="button">Voltar aos testes</button></div>
    <form class="editor-layout" id="editor" novalidate>
      <nav class="editor-nav" aria-label="Etapas de configuração">
      ${['Dados do teste','Protocolo','Instruções'].map((title,index) => `<button type="button" data-step="${index}"><span>${index + 1}</span>${title}</button>`).join('')}
      </nav><div class="panel stack editor-body">
      <div class="stack" data-page="0"><h2>Dados do teste</h2>
      <label class="field">Tipo de teste<select name="type" ${existing ? 'disabled' : ''}>
      ${Object.entries(library.types).map(([key, label]) => `<option value="${key}" ${key === type ? 'selected' : ''}>${e(label)}</option>`).join('')}</select></label>
      <div class="stack" id="identity"></div></div>
      <div class="stack" id="config" data-page="1"></div>
      <div class="stack" id="guidance" data-page="2"></div>
      <p class="error" role="alert" hidden></p>
      <div class="actions editor-actions"><button type="button" class="button secondary" id="prev-step">Anterior</button><button type="button" class="button" id="next-step">Continuar</button><button class="button" type="submit">Guardar teste</button></div></div>
    </form>`;
  const form = app.querySelector('#editor');
  const area = app.querySelector('#config');
  app.querySelector('#back').onclick = () => dashboard().catch(fail);
  let step = 0;
  const drafts = new Map();
  function showStep(index, focus = true) {
    step = index;
    for (const page of form.querySelectorAll('[data-page]')) page.hidden = Number(page.dataset.page) !== step;
    for (const item of form.querySelectorAll('[data-step]')) {
      item.setAttribute('aria-current', Number(item.dataset.step) === step ? 'step' : 'false');
    }
    form.querySelector('#prev-step').hidden = step === 0;
    form.querySelector('#next-step').hidden = step === 2;
    form.querySelector('[type="submit"]').hidden = step !== 2;
    if (focus) {
      const heading = form.querySelector('[data-page]:not([hidden]) h2');
      heading.tabIndex = -1;
      heading.focus();
    }
  }
  for (const item of form.querySelectorAll('[data-step]')) item.onclick = () => showStep(Number(item.dataset.step));
  form.querySelector('#prev-step').onclick = () => showStep(step - 1);
  form.querySelector('#next-step').onclick = () => {
    const invalid = form.querySelector('[data-page]:not([hidden]) :is(input, textarea, select):invalid');
    if (invalid) return invalid.reportValidity();
    showStep(step + 1);
  };
  form.elements.type.onchange = () => {
    const previous = { ...config, ...Object.fromEntries(new FormData(form)) };
    if (type === 'survey') previous.questions = readQuestions();
    drafts.set(type, previous);
    const oldDefaults = library.defaults[type];
    type = form.elements.type.value;
    config = structuredClone(drafts.get(type) || library.defaults[type]);
    for (const key of ['title','description','notice']) {
      if (previous[key] !== oldDefaults[key]) config[key] = previous[key];
    }
    draw();
  };

  function drawQuestions() {
    const list = area.querySelector('#questions');
    list.innerHTML = config.questions.map((question, index) => `
      <section class="question-editor stack tight" data-question="${index}">
        <div class="row"><h3>Pergunta ${index + 1}</h3><button type="button" class="button compact secondary danger" data-remove="${index}" aria-label="Remover pergunta ${index + 1}">Remover</button></div>
        ${field('prompt', 'Pergunta', question.prompt, 500, true)}
        <label class="field">Formato<select name="questionType">
          ${Object.entries(questionTypes).map(([key, label]) => `<option value="${key}" ${key === question.type ? 'selected' : ''}>${label}</option>`).join('')}
        </select></label>
        ${question.type === 'choice' ? `<fieldset class="option-list"><legend>Opções de resposta</legend>
          ${question.options.map((option, pos) => `<div class="option-row">${field('option', 'Opção ' + (pos + 1), option, 160, true)}
          <button type="button" class="button secondary compact" data-drop-option="${pos}" aria-label="Remover opção ${pos + 1}" ${question.options.length <= 2 ? 'disabled' : ''}>Remover</button></div>`).join('')}
          <button type="button" class="button secondary compact" data-add-option ${question.options.length >= 20 ? 'disabled' : ''}>Adicionar opção</button></fieldset>` : ''}
        ${question.type === 'rating' ? `<div class="grid-fields">${numberInput('min', 'Mínimo', question.min, 0, 9)}${numberInput('max', 'Máximo', question.max, 1, 10)}</div>` : ''}
        <label class="check"><input name="required" type="checkbox" ${question.required ? 'checked' : ''}> Resposta obrigatória</label>
      </section>`).join('');
    area.querySelector('#add-question').disabled = config.questions.length >= 60;
  }

  function readQuestions() {
    return [...area.querySelectorAll('[data-question]')].map(row => {
      const input = name => row.querySelector(`[name="${name}"]`);
      return {
        prompt: input('prompt').value,
        type: input('questionType').value,
        required: input('required').checked,
        options: row.querySelector('.option-list') ? [...row.querySelectorAll('[name=option]')].map(input => input.value) : ['', ''],
        min: input('min')?.valueAsNumber ?? 1,
        max: input('max')?.valueAsNumber ?? 5,
      };
    });
  }

  function draw() {
    form.querySelector('#identity').innerHTML = `
      ${field('title', 'Título do teste', config.title, 100, true)}
      ${textarea('description', 'Descrição breve', config.description, 1000)}`;
    form.querySelector('#guidance').innerHTML = `<h2>Instruções aos participantes</h2>
      ${textarea('notice', 'Informação aos participantes', config.notice, 6000, 'Adicione o texto do estudo a apresentar antes da recolha de dados.')}
      ${textarea('instructions', type === 'stop' ? 'Instruções da segunda fase' : 'Instruções', config.instructions, 3000,
        type === 'survey' ? '' : 'Se deixar em branco, serão usadas instruções baseadas nas teclas e nos estímulos configurados.')}
      ${type === 'stop' ? textarea('baselineInstructions', 'Instruções da fase inicial', config.baselineInstructions, 3000) : ''}
      ${existing ? '<p class="meta">As alterações aplicam-se apenas aos novos convites.</p>' : ''}`;
    area.innerHTML = `<h2>${type === 'survey' ? 'Perguntas do questionário' : 'Protocolo do teste'}</h2>
      ${type === 'survey' ? `<div class="stack" id="questions"></div><button class="button secondary" id="add-question" type="button">Adicionar pergunta</button>` :
        ['Estímulos e teclas', 'Número de ensaios', 'Tempos e intervalos'].map((title, group) => {
          const fields = taskFields[type].filter(([name, , min]) => (min === undefined ? 0 : /Count|Limit|Streak/.test(name) ? 1 : 2) === group);
          return `<fieldset><legend>${title}</legend><div class="grid-fields">${fields.map(([name, label, min, max]) =>
            min === undefined ? field(name, label, config[name], name.endsWith('Key') ? 5 : 40, true) : numberInput(name, label, config[name], min, max)).join('')}</div></fieldset>`;
        }).join('')}`;
    if (type !== 'survey') return;
    drawQuestions();
    area.querySelector('#add-question').onclick = () => {
      config.questions = readQuestions();
      config.questions.push({ prompt: '', type: 'choice', options: ['', ''], required: true });
      drawQuestions();
      [...area.querySelectorAll('[name="prompt"]')].at(-1)?.focus();
    };
    const list = area.querySelector('#questions');
    list.onclick = event => {
      const option = event.target.closest('[data-add-option], [data-drop-option]');
      if (option) {
        const index = Number(option.closest('[data-question]').dataset.question);
        config.questions = readQuestions();
        const options = config.questions[index].options;
        const position = option.hasAttribute('data-add-option') ? options.length : Number(option.dataset.dropOption);
        if (position === options.length) options.push('');
        else options.splice(position, 1);
        drawQuestions();
        list.querySelectorAll(`[data-question="${index}"] [name=option]`)[Math.min(position, options.length - 1)].focus();
        return;
      }
      const button = event.target.closest('[data-remove]');
      if (!button) return;
      config.questions = readQuestions();
      config.questions.splice(Number(button.dataset.remove), 1);
      drawQuestions();
    };
    list.onchange = event => {
      if (event.target.name !== 'questionType') return;
      const index = Number(event.target.closest('[data-question]').dataset.question);
      config.questions = readQuestions();
      drawQuestions();
      list.querySelector(`[data-question="${index}"] [name="questionType"]`)?.focus();
    };
  }

  draw();
  showStep(0, false);
  form.onsubmit = async event => {
    event.preventDefault();
    if (step < 2) return form.querySelector('#next-step').click();
    const invalid = form.querySelector('input:invalid, textarea:invalid, select:invalid');
    if (invalid) {
      showStep(Number(invalid.closest('[data-page]').dataset.page));
      return invalid.reportValidity();
    }
    const button = form.querySelector('[type="submit"]');
    const error = form.querySelector('.error');
    const next = Object.fromEntries(new FormData(form));
    if (type === 'survey') {
      next.questions = readQuestions().map(question => ({
        ...question, options: question.options.map(option => option.trim()).filter(Boolean),
      }));
    } else {
      for (const [name, , min] of taskFields[type]) if (min !== undefined) next[name] = Number(next[name]);
    }
    button.disabled = true;
    showError(error);
    try {
      const saved = await api('/api/admin/tests' + (existing ? '/' + existing.id : ''), {
        method: existing ? 'PUT' : 'POST', data: { type, config: next, editToken: existing?.editToken },
      });
      await dashboard(saved.id);
      notify('Teste guardado.');
    } catch (failure) {
      if (failure.status === 401) await fail(failure);
      else {
        if (failure.status === 400) showStep(1);
        showError(error, failure);
      }
    } finally { button.disabled = false; }
  };
}

void initialize();
