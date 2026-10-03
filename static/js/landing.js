(function () {
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var $ = function (s) { return document.querySelector(s); };

    /* theme (same behaviour as login/signup pages) */
    window.toggleTheme = function () {
        var nxt = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', nxt);
        try { localStorage.setItem('theme', nxt); } catch (e) {}
        icon(nxt);
    };
    function icon(t) {
        document.querySelectorAll('.theme-icon').forEach(function (el) {
            el.className = 'theme-icon fas ' + (t === 'light' ? 'fa-moon' : 'fa-sun');
        });
    }
    icon(document.documentElement.getAttribute('data-theme') || 'dark');

    /* nav blur + scroll progress */
    var nav = $('#nav'), bar = $('#progress'), ticking = false;
    function onScroll() {
        var y = window.scrollY, max = document.documentElement.scrollHeight - innerHeight;
        nav.classList.toggle('is-stuck', y > 12);
        bar.style.transform = 'scaleX(' + (max > 0 ? y / max : 0) + ')';
        ticking = false;
    }
    addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
    onScroll();

    /* scroll reveal (staggering comes from --d on each element) */
    var targets = document.querySelectorAll('.reveal');
    if (reduce || !('IntersectionObserver' in window)) {
        targets.forEach(function (el) { el.classList.add('in'); });
    } else {
        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (e) {
                if (!e.isIntersecting) return;
                e.target.classList.add('in');
                if (e.target.id === 'steps') e.target.style.setProperty('--p', 1);
                io.unobserve(e.target);
            });
        }, { threshold: 0.18, rootMargin: '0px 0px -40px 0px' });
        targets.forEach(function (el) { io.observe(el); });
    }

    /* infinite marquee: duplicate the track content once */
    var track = $('#marquee');
    if (track) track.innerHTML += track.innerHTML;

    if (!reduce) {
        /* cursor spotlight on cards */
        document.querySelectorAll('.card').forEach(function (c) {
            c.addEventListener('pointermove', function (e) {
                var r = c.getBoundingClientRect();
                c.style.setProperty('--mx', (e.clientX - r.left) + 'px');
                c.style.setProperty('--my', (e.clientY - r.top) + 'px');
            });
        });

        /* gentle tilt on the hero monitor (fine pointers only) */
        var m = $('#monitor');
        if (m && matchMedia('(pointer: fine)').matches) {
            m.addEventListener('pointermove', function (e) {
                var r = m.getBoundingClientRect();
                var x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
                m.style.setProperty('--ry', (x * 7).toFixed(2) + 'deg');
                m.style.setProperty('--rx', (-y * 7).toFixed(2) + 'deg');
            });
            m.addEventListener('pointerleave', function () {
                m.style.setProperty('--rx', '0deg'); m.style.setProperty('--ry', '0deg');
            });
        }
    }

    /* if already signed in, point the CTAs at the dashboard */
    fetch('/me', { credentials: 'include' }).then(function (r) {
        if (!r.ok) return;
        var login = $('#nav-login'), cta = $('#nav-cta');
        if (login) { login.href = '/app'; login.textContent = 'Open assistant'; }
        if (cta) { cta.href = '/dashboard'; cta.textContent = 'Dashboard'; }
        ['#hero-cta', '#cta-btn'].forEach(function (s) {
            var b = $(s); if (b) { b.href = '/dashboard'; b.innerHTML = 'Go to dashboard <i class="fas fa-arrow-right"></i>'; }
        });
    }).catch(function () {});
})();
