// Interactive bash.js playground: an xterm.js terminal with a small line editor
// (history, cursor movement, tab completion, multi-line input) driving a
// persistent BashJS session over an in-memory filesystem.
(function () {
  'use strict';

  var HOME = '/home/user';
  var PROJECT = HOME + '/project';

  function seedTree() {
    var t = {};
    t[HOME + '/.bashrc'] = 'export EDITOR=vi\n';
    t[PROJECT + '/README.md'] = [
      '# demo project',
      '',
      'A tiny project to play with. Everything here lives in memory,',
      'so feel free to rm -rf it all and press Reset.',
      ''
    ].join('\n');
    t[PROJECT + '/src/app.js'] = [
      "const { add, mul } = require('./utils');",
      '',
      '// TODO: read the numbers from data/sales.csv',
      'const total = add(2, mul(3, 4));',
      "console.log('total:', total);",
      ''
    ].join('\n');
    t[PROJECT + '/src/utils.js'] = [
      'function add(a, b) { return a + b; }',
      'function mul(a, b) { return a * b; }',
      '// TODO: handle non-numeric input',
      'module.exports = { add, mul };',
      ''
    ].join('\n');
    t[PROJECT + '/src/lib/format.js'] = [
      '// FIXME: locale-aware formatting',
      'exports.money = (n) => n.toFixed(2) + " EUR";',
      '// TODO: support other currencies',
      ''
    ].join('\n');
    t[PROJECT + '/data/sales.csv'] = [
      'date,region,amount',
      '2026-01-03,north,120',
      '2026-01-04,south,80',
      '2026-01-04,north,45',
      '2026-01-05,east,200',
      '2026-01-06,south,60',
      '2026-01-07,east,15',
      ''
    ].join('\n');
    t[PROJECT + '/data/a.txt'] = 'cherry\napple\nbanana\ndate\n';
    t[PROJECT + '/data/b.txt'] = 'banana\napple\nelderberry\ncherry\n';
    t[PROJECT + '/config.ini'] = '[server]\nhost=localhost\nport=80\n\n[db]\nport=5432\n';
    t[PROJECT + '/.gitignore'] = 'node_modules/\n*.log\n';
    return t;
  }

  var HELP = [
    '\x1b[1mbash.js playground\x1b[0m',
    '',
    'This is a real bash.js session running on an in-memory filesystem.',
    'State (cwd, variables, functions, files) persists until you press Reset.',
    '',
    '\x1b[1mTry:\x1b[0m',
    '  ls -la src                       grep -rn TODO .',
    '  cat data/sales.csv | sort -t, -k3 -n',
    '  awk -F, \'NR>1{s[$2]+=$3} END{for(k in s) print k, s[k]}\' data/sales.csv',
    '  diff -u data/a.txt data/b.txt > ab.patch; cat ab.patch',
    '  greet() { echo "hello, ${1:-world}"; }; greet bash.js',
    '  echo {a..e} $((6*7)) ~',
    '',
    '\x1b[1mKeys:\x1b[0m  ↑/↓ history · Tab complete · Ctrl+C cancel line · Ctrl+L clear',
    '        Ctrl+A/E start/end · Ctrl+U/K cut · Ctrl+W delete word',
    '',
    '\x1b[1mCommands:\x1b[0m ' + '%COMMANDS%',
    ''
  ].join('\n');

  // ----- Load dependencies -----
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  // On GitHub Pages bash.js sits next to this page; in a local checkout it is one level up.
  function loadBashJS() {
    if (window.BashJS) return Promise.resolve();
    return loadScript('bash.js').catch(function () { return loadScript('../bash.js'); });
  }

  var container = document.getElementById('terminal');
  if (!container) return;

  loadBashJS().then(start, function () {
    container.innerHTML = '<div class="term-loading">Could not load bash.js.</div>';
  });

  function start() {
    var BashJS = window.BashJS;
    container.innerHTML = '';

    var term = new window.Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.25,
      scrollback: 5000,
      allowProposedApi: false,
      theme: {
        background: '#16161a',
        foreground: '#dfdfd6',
        cursor: '#3dd68c',
        cursorAccent: '#16161a',
        selectionBackground: 'rgba(61, 214, 140, 0.3)',
        black: '#16161a', brightBlack: '#6a737d',
        red: '#f97583', brightRed: '#ff9aa8',
        green: '#3dd68c', brightGreen: '#6ee7a8',
        yellow: '#e2c08d', brightYellow: '#f0d9a8',
        blue: '#5ab8ff', brightBlue: '#8ccdff',
        magenta: '#b392f0', brightMagenta: '#cbb2f5',
        cyan: '#56d4dd', brightCyan: '#8ae4ea',
        white: '#dfdfd6', brightWhite: '#ffffff'
      }
    });
    var fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(container);
    // Keep rows/cols matched to the container: refit whenever it changes size
    // (window resize, layout shifts) and once web fonts have loaded, since the
    // cell size depends on the font.
    var fitFrame = 0;
    function refit() {
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(function () {
        if (container.clientWidth && container.clientHeight) fit.fit();
      });
    }
    fit.fit();
    if (window.ResizeObserver) new ResizeObserver(refit).observe(container);
    else window.addEventListener('resize', refit);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit);

    // ----- Custom commands for the playground -----
    BashJS.registerCommand('help', function (ctx) {
      var names = BashJS.commands().filter(function (n) { return /^[a-z]/.test(n); });
      ctx.stdout.write(HELP.replace('%COMMANDS%', wrapWords(names, 70, 10)));
      return 0;
    });
    BashJS.registerCommand('clear', function (ctx) {
      ctx.stdout.write('\x1b[2J\x1b[3J\x1b[H');
      return 0;
    });

    function wrapWords(words, width, indent) {
      var lines = [], line = '';
      words.forEach(function (w) {
        if (line && line.length + w.length + 1 > width - indent) { lines.push(line); line = ''; }
        line += (line ? ' ' : '') + w;
      });
      if (line) lines.push(line);
      return lines.join('\n' + new Array(indent + 1).join(' '));
    }

    // ----- Session -----
    var fs, sh, lastExit = 0, lastOut = '\n';
    function newSession() {
      fs = BashJS.memfs(seedTree());
      sh = BashJS.create({
        cwd: PROJECT,
        read: fs.read, write: fs.write, delete: fs.delete, move: fs.move,
        stat: fs.stat, exists: fs.exists,
        env: { HOME: HOME, USER: 'user', PATH: '/usr/bin:/bin', SHELL: '/bin/bash', TERM: 'xterm-256color' },
        stdout: write,
        stderr: function (s) { write('\x1b[31m' + s + '\x1b[0m'); }
      });
    }
    function write(s) {
      s = String(s);
      if (!s) return;
      term.write(s);
      lastOut = s;
    }

    // ----- Line editor -----
    var line = '', cursor = 0, pending = '', busy = false;
    var history = [], histIndex = 0, draft = '';
    var promptText = '', promptLen = 0, renderedCursor = 0;
    var queue = [];

    function displayCwd() {
      var cwd = sh.getCwd();
      if (cwd === HOME) return '~';
      if (cwd.indexOf(HOME + '/') === 0) return '~' + cwd.slice(HOME.length);
      return cwd;
    }
    function setTitle() {
      var el = document.querySelector('.term-title');
      if (el) el.textContent = 'user@bash.js: ' + displayCwd();
    }

    function prompt() {
      var continuation = !!pending;
      if (continuation) {
        promptText = '\x1b[90m> \x1b[0m';
        promptLen = 2;
      } else {
        var exit = lastExit;
        var dir = displayCwd();
        var mark = exit ? '\x1b[31m' + exit + ' \x1b[0m' : '';
        promptText = mark + '\x1b[1;32muser@bash.js\x1b[0m:\x1b[1;34m' + dir + '\x1b[0m$ ';
        promptLen = (exit ? String(exit).length + 1 : 0) + 'user@bash.js:'.length + dir.length + 2;
        setTitle();
      }
      line = ''; cursor = 0; renderedCursor = 0;
      term.write(promptText);
    }

    // Redraws prompt + line and puts the cursor where it belongs, handling wraps.
    function render() {
      var cols = term.cols;
      var up = Math.floor((promptLen + renderedCursor) / cols);
      var out = '';
      if (up > 0) out += '\x1b[' + up + 'A';
      out += '\r\x1b[J' + promptText + line;
      var end = promptLen + line.length;
      if (end > 0 && end % cols === 0) out += '\r\n';
      var target = promptLen + cursor;
      var rowsUp = Math.floor(end / cols) - Math.floor(target / cols);
      if (rowsUp > 0) out += '\x1b[' + rowsUp + 'A';
      out += '\r';
      if (target % cols) out += '\x1b[' + (target % cols) + 'C';
      term.write(out);
      renderedCursor = cursor;
    }

    function insert(text) {
      line = line.slice(0, cursor) + text + line.slice(cursor);
      cursor += text.length;
      render();
    }

    function isIncomplete(src) {
      if (/(^|[^\\])(\\\\)*\\$/.test(src)) return true;
      try { BashJS.parse(src); return false; }
      catch (e) { return /unexpected end of file|unterminated|missing here-document/.test(e.message); }
    }

    function moveToEnd() {
      cursor = line.length; render();
      term.write('\r\n');
    }

    async function submit() {
      moveToEnd();
      var src = pending ? pending + '\n' + line : line;
      if (isIncomplete(src)) { pending = src; prompt(); return; }
      pending = '';
      if (src.trim()) {
        if (history[history.length - 1] !== src) history.push(src);
        try { localStorage.setItem('bashjs-history', JSON.stringify(history.slice(-200))); } catch (_) {}
      }
      histIndex = history.length;
      if (src.trim()) {
        busy = true;
        lastOut = '\n';
        try { lastExit = (await sh.exec(src)).exitCode; }
        catch (e) { write('\x1b[31mbash.js: ' + (e && e.message || e) + '\x1b[0m\n'); }
        busy = false;
        // Like zsh: mark output that did not end in a newline.
        if (lastOut.slice(-1) !== '\n' && !/\x1b\[H$/.test(lastOut)) term.write('\x1b[7m%\x1b[0m\r\n');
      }
      prompt();
      drain();
    }

    function historyMove(delta) {
      if (!history.length) return;
      if (histIndex === history.length) draft = line;
      var next = Math.max(0, Math.min(history.length, histIndex + delta));
      if (next === histIndex) return;
      histIndex = next;
      line = histIndex === history.length ? draft : history[histIndex];
      cursor = line.length;
      render();
    }

    // ----- Tab completion -----
    function listDir(dir) {
      var node = fs.read(dir);
      if (!node || node.type !== 'dir') return [];
      return node.entries.map(function (e) {
        return typeof e === 'string' ? { name: e, type: (fs.stat(dir + '/' + e) || {}).type } : e;
      });
    }
    function resolve(p) {
      if (p === '~' || p.indexOf('~/') === 0) p = HOME + p.slice(1);
      return BashJS._internals.resolvePath(sh.getCwd(), p);
    }
    function commonPrefix(list) {
      if (!list.length) return '';
      var p = list[0];
      list.forEach(function (s) { while (s.indexOf(p) !== 0) p = p.slice(0, -1); });
      return p;
    }
    function complete() {
      var before = line.slice(0, cursor);
      var m = /(?:^|[\s;|&<>(])([^\s;|&<>()]*)$/.exec(before);
      var word = m ? m[1] : '';
      var head = before.slice(0, before.length - word.length);
      var isCommand = /^\s*$|[;|&(]\s*$/.test(head) && word.indexOf('/') < 0;
      var candidates, prefix = '', base = word;

      if (isCommand) {
        candidates = BashJS.commands().filter(function (n) { return /^[a-z]/.test(n) && n.indexOf(word) === 0; })
          .map(function (n) { return { text: n, suffix: ' ' }; });
      } else {
        var slash = word.lastIndexOf('/');
        prefix = slash >= 0 ? word.slice(0, slash + 1) : '';
        base = word.slice(prefix.length);
        var dir = resolve(prefix || '.');
        candidates = listDir(dir)
          .filter(function (e) { return e.name.indexOf(base) === 0 && (base[0] === '.' || e.name[0] !== '.'); })
          .map(function (e) { return { text: e.name, suffix: e.type === 'dir' ? '/' : ' ' }; });
      }
      if (!candidates.length) return;
      if (candidates.length === 1) {
        insert(candidates[0].text.slice(base.length) + candidates[0].suffix);
        return;
      }
      var names = candidates.map(function (c) { return c.text; }).sort();
      var common = commonPrefix(names);
      if (common.length > base.length) { insert(common.slice(base.length)); return; }
      // Show the options below and redraw the line.
      var keep = line, keepCursor = cursor;
      moveToEnd();
      var shown = candidates.map(function (c) { return c.text + (c.suffix === '/' ? '/' : ''); }).sort();
      term.write(wrapWords(shown, term.cols, 0).replace(/ /g, '  ') + '\r\n');
      term.write(promptText);
      line = keep; cursor = keepCursor; renderedCursor = line.length;
      term.write(line);
      render();
    }

    // ----- Input handling -----
    function handle(data) {
      if (busy) { queue.push(data); return; }
      // Pasted text: run it line by line.
      if (data.length > 1 && data.charCodeAt(0) !== 27 && /[\r\n]/.test(data)) {
        var parts = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        insert(parts.shift());
        parts.forEach(function (p) { queue.push('\r'); if (p) queue.push(p); });
        drain();
        return;
      }
      switch (data) {
        case '\r': submit(); return;
        case '\x7f': case '\b':
          if (cursor > 0) { line = line.slice(0, cursor - 1) + line.slice(cursor); cursor--; render(); }
          return;
        case '\x1b[3~':
          if (cursor < line.length) { line = line.slice(0, cursor) + line.slice(cursor + 1); render(); }
          return;
        case '\x1b[D': if (cursor > 0) { cursor--; render(); } return;
        case '\x1b[C': if (cursor < line.length) { cursor++; render(); } return;
        case '\x1b[A': historyMove(-1); return;
        case '\x1b[B': historyMove(1); return;
        case '\x1b[H': case '\x1bOH': case '\x1b[1~': case '\x01': cursor = 0; render(); return;
        case '\x1b[F': case '\x1bOF': case '\x1b[4~': case '\x05': cursor = line.length; render(); return;
        case '\x1b[1;5D': case '\x1bb': cursor = wordLeft(); render(); return;
        case '\x1b[1;5C': case '\x1bf': cursor = wordRight(); render(); return;
        case '\t': complete(); return;
        case '\x03':
          cursor = line.length; render();
          term.write('^C\r\n');
          pending = ''; histIndex = history.length;
          prompt();
          return;
        case '\x0c':
          term.write('\x1b[2J\x1b[3J\x1b[H');
          renderedCursor = 0;
          render();
          return;
        case '\x15': line = line.slice(cursor); cursor = 0; render(); return;
        case '\x0b': line = line.slice(0, cursor); render(); return;
        case '\x17': {
          var start = wordLeft();
          line = line.slice(0, start) + line.slice(cursor); cursor = start; render();
          return;
        }
        case '\x04':
          if (!line) { term.write('\r\n\x1b[90m(there is nowhere to exit to; press Reset to start over)\x1b[0m\r\n'); prompt(); }
          return;
      }
      if (data.charCodeAt(0) === 27) return; // other escape sequences
      var printable = data.replace(/[\x00-\x1f\x7f]/g, '');
      if (printable) insert(printable);
    }
    function wordLeft() {
      var i = cursor;
      while (i > 0 && line[i - 1] === ' ') i--;
      while (i > 0 && line[i - 1] !== ' ') i--;
      return i;
    }
    function wordRight() {
      var i = cursor;
      while (i < line.length && line[i] === ' ') i++;
      while (i < line.length && line[i] !== ' ') i++;
      return i;
    }
    function drain() {
      while (!busy && queue.length) handle(queue.shift());
    }

    term.onData(handle);

    // ----- Boot / reset -----
    try { history = JSON.parse(localStorage.getItem('bashjs-history')) || []; } catch (_) { history = []; }
    function boot() {
      newSession(); lastExit = 0;
      pending = ''; queue = []; histIndex = history.length;
      term.reset();
      term.write('\x1b[1;32mbash.js ' + BashJS.version + '\x1b[0m interactive playground. ' +
        'Type \x1b[1mhelp\x1b[0m for ideas, or click an example below.\r\n\r\n');
      prompt();
    }
    boot();

    document.getElementById('term-reset').addEventListener('click', function () { boot(); term.focus(); });

    // Example chips: type the command into the terminal and run it.
    document.querySelectorAll('#chips .chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var cmd = chip.textContent;
        term.focus();
        if (busy) return;
        line = cmd; cursor = cmd.length; render();
        submit();
      });
    });
  }
})();
