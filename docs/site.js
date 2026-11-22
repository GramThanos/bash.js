// Page chrome: theme toggle, code blocks (highlight + copy), sidebar scroll-spy.
(function () {
  'use strict';

  // ----- Theme -----
  document.getElementById('theme-toggle').addEventListener('click', function () {
    var dark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('bashjs-theme', dark ? 'dark' : 'light');
  });

  // ----- Code blocks -----
  var KEYWORDS = /^(const|let|var|function|return|async|await|new|if|else|try|catch|throw|import|from|export|require|for|of|in|while)$/;
  var LITERALS = /^(true|false|null|undefined|\d[\d_.]*)$/;
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function highlightJs(src) {
    var re = /(\/\/[^\n]*)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|([A-Za-z_$][\w$]*|\d[\d_.]*)(\s*\()?/g;
    var out = '', last = 0, m;
    while ((m = re.exec(src))) {
      out += esc(src.slice(last, m.index));
      if (m[1]) out += '<span class="tk-c">' + esc(m[1]) + '</span>';
      else if (m[2]) out += '<span class="tk-s">' + esc(m[2]) + '</span>';
      else {
        var w = m[3], cls = KEYWORDS.test(w) ? 'tk-k' : LITERALS.test(w) ? 'tk-n' : m[4] ? 'tk-f' : '';
        out += cls ? '<span class="' + cls + '">' + esc(w) + '</span>' : esc(w);
        if (m[4]) out += esc(m[4]);
      }
      last = re.lastIndex;
    }
    return out + esc(src.slice(last));
  }
  function highlightHtml(src) {
    // Strings first, so the quotes in the inserted class attributes are not re-matched.
    return esc(src)
      .replace(/"([^"]*)"/g, '<span class="tk-s">"$1"</span>')
      .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tk-c">$1</span>')
      .replace(/(&lt;\/?)([a-z]+)/g, '$1<span class="tk-k">$2</span>');
  }

  var COPY_ICON = '<svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>';
  var CHECK_ICON = '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>';

  document.querySelectorAll('.doc pre[data-lang]').forEach(function (pre) {
    var lang = pre.getAttribute('data-lang');
    var code = pre.querySelector('code');
    var text = code.textContent;
    code.innerHTML = lang === 'html' ? highlightHtml(text) : highlightJs(text);

    var wrap = document.createElement('div');
    wrap.className = 'code';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);

    var label = document.createElement('span');
    label.className = 'lang';
    label.textContent = lang;
    wrap.appendChild(label);

    var btn = document.createElement('button');
    btn.className = 'copy';
    btn.title = 'Copy code';
    btn.innerHTML = COPY_ICON;
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(text).then(function () {
        btn.classList.add('copied'); btn.innerHTML = CHECK_ICON;
        setTimeout(function () { btn.classList.remove('copied'); btn.innerHTML = COPY_ICON; }, 1500);
      });
    });
    wrap.appendChild(btn);
  });

  // ----- Sidebar scroll-spy -----
  var links = Array.prototype.slice.call(document.querySelectorAll('#sidebar a'));
  var targets = links.map(function (a) { return document.querySelector(a.getAttribute('href')); });
  function spy() {
    var y = window.scrollY + 120, current = -1;
    targets.forEach(function (t, i) { if (t && t.offsetTop <= y) current = i; });
    links.forEach(function (a, i) { a.classList.toggle('active', i === current); });
  }
  window.addEventListener('scroll', spy, { passive: true });
  spy();
})();
