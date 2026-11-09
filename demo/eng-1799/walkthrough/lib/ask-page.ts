// ENG-1799 demo: the page scene 06-ai-question records. It is a self-contained HTML document (no network) loaded with
// page.setContent. The question box and the Ask button are real: Ask calls `window.askTelemetry(question)`, which the
// scene binds (page.exposeFunction) to the scripted MCP client in ../../ask/client.ts. The client runs in Node, signs
// in at the fake Okta and calls telemetry-mcp; the page then shows, one after the other, the tool call, the live
// query, the result table and the one-sentence answer. Every value is written with textContent, never as HTML.
//
// Test ids: ask-question, ask-submit, ask-status, ask-tool, ask-arguments, ask-query, ask-result (table),
// ask-row-count, ask-answer, ask-error.
export const ASK_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Ask telemetry-mcp</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1f2430; background: #f4f5f8; }
  header { display: flex; align-items: center; gap: 14px; padding: 18px 48px; background: #1f2430; color: #fff; }
  header .logo { width: 34px; height: 34px; border-radius: 8px; background: #7262ff; display: grid; place-items: center; font-weight: 700; }
  header h1 { margin: 0; font-size: 20px; font-weight: 600; }
  header .sub { margin-left: auto; font-size: 14px; color: #b9bfcc; }
  main { max-width: 1500px; margin: 22px auto; padding: 0 48px; display: grid; gap: 16px; }
  .card { background: #fff; border: 1px solid #dde0e7; border-radius: 12px; padding: 16px 24px; }
  .label { font-size: 12px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #6b7385; margin-bottom: 8px; }
  form { display: flex; gap: 12px; }
  input { flex: 1; font: inherit; font-size: 20px; padding: 12px 16px; border: 1px solid #c5cad6; border-radius: 10px; }
  button { font: inherit; font-size: 18px; font-weight: 600; padding: 12px 28px; border: 0; border-radius: 10px; background: #7262ff; color: #fff; cursor: pointer; }
  button:disabled { background: #a9a1ff; cursor: default; }
  #status { color: #6b7385; font-size: 15px; min-height: 22px; }
  .hidden { display: none !important; }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  code, pre { font-family: "SF Mono", Menlo, Consolas, monospace; }
  .tool { font-size: 20px; font-weight: 600; color: #4a3fd6; }
  pre { margin: 8px 0 0; padding: 12px 14px; background: #f4f5f8; border-radius: 8px; white-space: pre-wrap; word-break: break-all; font-size: 15px; }
  .query { font-size: 22px; background: #1f2430; color: #9fe0a8; }
  .scroll { max-height: 400px; overflow-y: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 15px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #eceef3; }
  th { color: #6b7385; font-weight: 600; position: sticky; top: 0; background: #fff; }
  td.num { font-variant-numeric: tabular-nums; font-weight: 600; }
  td.hot { color: #c92a2a; }
  .answer { font-size: 24px; font-weight: 500; }
  .error { color: #c92a2a; font-weight: 600; }
</style>
</head>
<body>
<header><div class="logo">L</div><h1>Ask telemetry-mcp</h1><span class="sub">Scripted MCP client (no model) &middot; signed in as the demo user through Okta</span></header>
<main>
  <section class="card">
    <div class="label">Question</div>
    <form id="ask-form">
      <input id="question" data-testid="ask-question" aria-label="Question" autocomplete="off" placeholder="Ask about the fill queue, logs or traces">
      <button id="submit" data-testid="ask-submit" type="submit">Ask</button>
    </form>
    <div id="status" data-testid="ask-status" role="status"></div>
    <div id="error" data-testid="ask-error" class="error hidden"></div>
  </section>
  <div id="call" class="row2 hidden">
    <section class="card">
      <div class="label">Tool call</div>
      <div class="tool" data-testid="ask-tool" id="tool"></div>
      <pre data-testid="ask-arguments" id="arguments"></pre>
    </section>
    <section class="card">
      <div class="label">Live query (PromQL)</div>
      <pre class="query" data-testid="ask-query" id="query"></pre>
    </section>
  </div>
  <section id="result-card" class="card hidden">
    <div class="label">Result <span data-testid="ask-row-count" id="row-count"></span></div>
    <div class="scroll"><table data-testid="ask-result" id="result"><thead></thead><tbody></tbody></table></div>
  </section>
  <section id="answer-card" class="card hidden">
    <div class="label">Answer</div>
    <div class="answer" data-testid="ask-answer" id="answer"></div>
  </section>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const show = (id) => $(id).classList.remove('hidden');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cell = (v) => {
    if (v && typeof v === 'object') {
      return '{' + Object.entries(v).filter(([k]) => k !== '__name__').map(([k, x]) => k + '="' + x + '"').join(', ') + '}';
    }
    return v === null || v === undefined ? '' : String(v);
  };
  $('ask-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const question = $('question').value.trim();
    if (!question) return;
    $('submit').disabled = true;
    $('status').textContent = 'Calling telemetry-mcp…';
    try {
      const out = await window.askTelemetry(question);
      $('status').textContent = 'telemetry-mcp answered with ' + out.tool;
      $('tool').textContent = out.tool;
      $('arguments').textContent = JSON.stringify(out.arguments);
      $('query').textContent = out.query;
      show('call');
      await sleep(1500);
      const head = document.createElement('tr');
      out.result.columns.forEach((c) => { const th = document.createElement('th'); th.textContent = c; head.appendChild(th); });
      $('result').tHead.appendChild(head);
      const valueAt = out.result.columns.indexOf('value');
      out.result.rows.slice().reverse().forEach((r) => {
        const tr = document.createElement('tr');
        tr.setAttribute('data-testid', 'ask-result-row');
        r.forEach((v, i) => {
          const td = document.createElement('td');
          td.textContent = cell(v);
          if (i === valueAt) { td.className = 'num' + (Number(v) >= 100 ? ' hot' : ''); }
          tr.appendChild(td);
        });
        $('result').tBodies[0].appendChild(tr);
      });
      $('row-count').textContent = '(' + out.result.rows.length + ' rows, newest first)';
      show('result-card');
      await sleep(1500);
      $('answer').textContent = out.answer;
      show('answer-card');
    } catch (err) {
      $('status').textContent = '';
      $('error').textContent = String(err && err.message ? err.message : err);
      show('error');
    } finally {
      $('submit').disabled = false;
    }
  });
</script>
</body>
</html>
`;
