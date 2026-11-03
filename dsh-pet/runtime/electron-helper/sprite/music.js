/**
 * 桌面 Helper 的音乐控制条：显隐、拉取 /music/state、三行歌词与四个按钮的渲染与点击。
 *
 * PetSprite 由 sprite.js 定义、本文件只往原型挂方法，须在 sprite-input 之后加载。
 * 数据只有 GET /music/state 一个来源；控制与收藏走 POST。悬浮显隐由 sprite-input 的 onMouseMove 驱动。
 * @module dsh-pet/runtime/electron-helper/sprite-music
 */
'use strict';

// 内联 SVG 图标（24×24，fill=currentColor）：避免字体符号渲染参差；线条统一、随按钮颜色走。
const MUSIC_ICON = {
  prev: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 6h2.2v12H7zM19 6.4v11.2c0 .5-.55.8-.97.53L9.5 12.53a.63.63 0 0 1 0-1.06l8.53-5.6c.42-.27.97.03.97.53z"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14.8 6H17v12h-2.2zM5 6.4v11.2c0 .5.55.8.97.53l8.53-5.6a.63.63 0 0 0 0-1.06L5.97 5.87A.62.62 0 0 0 5 6.4z"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5.2v13.6c0 .55.6.9 1.08.62l11-6.8a.73.73 0 0 0 0-1.24l-11-6.8A.72.72 0 0 0 7 5.2z"/></svg>',
  pause:
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="5" width="3.6" height="14" rx="1"/><rect x="13.9" y="5" width="3.6" height="14" rx="1"/></svg>',
  heart:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 20.3l-1.35-1.23C6.1 14.97 3 12.16 3 8.72 3 6.4 4.82 4.6 7.12 4.6c1.3 0 2.55.6 3.38 1.56l1.5 1.76 1.5-1.76A4.4 4.4 0 0 1 16.88 4.6C19.18 4.6 21 6.4 21 8.72c0 3.44-3.1 6.25-7.65 10.35z"/></svg>',
  heartFill:
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 20.3l-1.35-1.23C6.1 14.97 3 12.16 3 8.72 3 6.4 4.82 4.6 7.12 4.6c1.3 0 2.55.6 3.38 1.56l1.5 1.76 1.5-1.76A4.4 4.4 0 0 1 16.88 4.6C19.18 4.6 21 6.4 21 8.72c0 3.44-3.1 6.25-7.65 10.35z"/></svg>',
};

Object.assign(PetSprite.prototype, {
  /** 指针（窗口内坐标）是否落在控制条矩形上（含 4px 容差）。 */
  pointInMusicBar(wx, wy) {
    const r = this.musicEl.getBoundingClientRect();
    return wx >= r.left - 4 && wx <= r.right + 4 && wy >= r.top - 4 && wy <= r.bottom + 4;
  },

  /** 显示控制条并确保轮询在跑。 */
  showMusic() {
    if (this.musicHideTimer !== null) {
      window.clearTimeout(this.musicHideTimer);
      this.musicHideTimer = null;
    }
    if (this.musicOn) return;
    this.musicOn = true;
    this.musicEl.classList.add('is-open');
    // 先渲染占位（有高度才能立即看见/可点），数据到了再覆盖。
    this.renderMusic(
      this.musicState || { reason: '', prev: '', cur: '正在读取…', next: '', liked: false, playing: false },
    );
    this.syncInputBusy();
    this.startMusicPoll();
  },

  /** 延时收起（280ms 防抖）；鼠标回到身体或条上会被 showMusic 取消。锁定时常驻不收起。 */
  hideMusicSoon() {
    if (!this.musicOn || this.musicLocked || this.musicHideTimer !== null) return;
    this.musicHideTimer = window.setTimeout(() => {
      this.musicHideTimer = null;
      this.musicOn = false;
      this.musicEl.classList.remove('is-open');
      this.stopMusicPoll();
      this.syncInputBusy();
    }, 280);
  },

  startMusicPoll() {
    if (this.musicTimer !== null) return;
    const tick = () => {
      fetch(BASE + '/music/state', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => {
          if (s && this.musicOn) {
            this.musicState = s;
            this.renderMusic(s);
          }
        })
        .catch(() => undefined);
    };
    tick();
    this.musicTimer = window.setInterval(tick, 800);
  },

  stopMusicPoll() {
    if (this.musicTimer !== null) {
      window.clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  },

  /** 发一次控制/收藏请求。POST 后稍等再拉状态：SMTC 反映切歌/暂停有几百毫秒延迟，
   *  立刻拉会拉回旧值。拉回来的只是增量更新文本，不再重建 DOM。 */
  musicAction(path) {
    fetch(BASE + '/' + path, { method: 'POST' })
      .catch(() => undefined)
      .then(() => {
        window.setTimeout(() => {
          if (!this.musicOn) return;
          fetch(BASE + '/music/state', { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then((s) => s && this.musicOn && this.renderMusic(s))
            .catch(() => undefined);
        }, 350);
      });
  },

  /**
   * 渲染两行歌词 + 四按钮。**只建一次结构，之后按需更新**——轮询每 800ms 都会调到这里，
   * 若每次清空重建，鼠标停在按钮上会因 DOM 被替换而闪跳，点击也会被下一次重建打断（连点被吞）。
   * reason 非空时只显示提示文案（复用同一个提示节点）。
   */
  renderMusic(s) {
    const el = this.musicEl;
    if (s.reason) {
      // 登录进行中：不要用"请先扫码登录"覆盖掉"正在获取/已打开授权页"的反馈。
      if (!this._musicLoginBusy) this.updateMusicTip(this.musicReasonText(s.reason));
      return;
    }
    this.updateMusicTip(null); // 清除提示
    const p = this.ensureMusicParts();
    this.setText(p.cur, s.cur);
    this.setText(p.next, s.next);
    this.updateLyricScroll(p.cur);
    this.updateLyricScroll(p.next);

    // 按钮：只更新图标与状态类，不重建节点、不重绑事件。
    const liked = s.liked === true;
    p.btnLike.innerHTML = liked ? MUSIC_ICON.heartFill : MUSIC_ICON.heart;
    p.btnLike.classList.toggle('is-on', liked);
    p.btnLike.title = liked ? '取消收藏' : '收藏';
    p.btnPlay.innerHTML = s.playing ? MUSIC_ICON.pause : MUSIC_ICON.play;
    p.btnPlay.title = s.playing ? '暂停' : '播放';
    p.btnPlay.setAttribute('aria-label', p.btnPlay.title);

    // 锁定时按钮栏默认隐藏；悬浮中则显示。只在锁定态管理 is-hidden。
    if (this.musicLocked) p.bar.classList.toggle('is-hidden', !this.musicBarHover);
    else p.bar.classList.remove('is-hidden');

    this.syncInputRegions();
  },

  /** 首次构建音乐条 DOM（惰性）；返回节点引用供后续增量更新。 */
  ensureMusicParts() {
    if (this.musicParts) return this.musicParts;
    const el = this.musicEl;
    el.textContent = '';
    this.bindMusicHover();
    const lines = document.createElement('div');
    lines.className = 'pet-music__lyrics';
    const cur = this.makeLyricLine('cur', '');
    const next = this.makeLyricLine('next', '');
    lines.appendChild(cur);
    lines.appendChild(next);
    const bar = document.createElement('div');
    bar.className = 'pet-music__bar';
    const mk = (cls, icon, path, title) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pet-music__btn ' + cls;
      btn.innerHTML = icon;
      btn.title = title;
      btn.setAttribute('aria-label', title);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.musicAction(path);
      });
      bar.appendChild(btn);
      return btn;
    };
    const btnLike = mk('like', MUSIC_ICON.heart, 'music/like', '收藏');
    const btnPrev = mk('prev', MUSIC_ICON.prev, 'music/control?action=prev', '上一首');
    const btnPlay = mk('play', MUSIC_ICON.play, 'music/control?action=playpause', '播放');
    const btnNext = mk('next', MUSIC_ICON.next, 'music/control?action=next', '下一首');
    el.appendChild(lines);
    el.appendChild(bar);
    this.musicParts = { cur, next, bar, btnLike, btnPrev, btnPlay, btnNext };
    return this.musicParts;
  },

  /** 提示文案：text 为 null/'' 时清除；否则惰性建一个提示节点。 */
  updateMusicTip(text) {
    const el = this.musicEl;
    let tip = el.querySelector('.pet-music__tip');
    if (!text) {
      if (tip) tip.remove();
      return;
    }
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'pet-music__tip';
      el.appendChild(tip);
    }
    if (tip.textContent !== text) tip.textContent = text;
  },

  /** 设置某行文本（变了才写，避免打断 marquee 动画）。 */
  setText(row, text) {
    const inner = row.firstElementChild;
    const t = text || '';
    if (inner.textContent !== t) inner.textContent = t;
  },

  /** 按实际宽度决定该行是否滚动（只在超宽时加 is-scroll 并写入滚动参数）。 */
  updateLyricScroll(row) {
    const inner = row.firstElementChild;
    const over = row.scrollWidth - row.clientWidth;
    if (over > 1) {
      inner.classList.add('is-scroll');
      inner.style.setProperty('--scroll-dist', over + 'px');
      inner.style.setProperty('--scroll-dur', Math.max(6, over / 30) + 's');
    } else {
      inner.classList.remove('is-scroll');
    }
  },

  /** 绑定一次：鼠标进入/离开整条歌词条时切换按钮栏显隐（锁定态用）。 */
  bindMusicHover() {
    if (this._musicHoverBound || !this.musicEl) return;
    this._musicHoverBound = true;
    this.musicEl.addEventListener('pointerenter', () => {
      this.musicBarHover = true;
      const bar = this.musicEl.querySelector('.pet-music__bar');
      if (bar) bar.classList.remove('is-hidden');
      this.syncInputRegions();
    });
    this.musicEl.addEventListener('pointerleave', () => {
      this.musicBarHover = false;
      const bar = this.musicEl.querySelector('.pet-music__bar');
      if (bar && this.musicLocked) bar.classList.add('is-hidden');
      this.syncInputRegions();
    });
  },

  /** 生成一行歌词；文本超出容器宽度时包一层做横向滚动（marquee）。 */
  makeLyricLine(cls, text) {
    const row = document.createElement('div');
    row.className = 'pet-music__line pet-music__line--' + cls;
    const inner = document.createElement('span');
    inner.className = 'pet-music__line-inner';
    inner.textContent = text || '';
    row.appendChild(inner);
    // 插入后（下一帧）按实际宽度判断是否超宽，超宽才滚动，并停一次再走。
    requestAnimationFrame(() => {
      if (row.scrollWidth > row.clientWidth + 1) {
        inner.classList.add('is-scroll');
        inner.style.setProperty('--scroll-dist', row.scrollWidth - row.clientWidth + 'px');
        inner.style.setProperty('--scroll-dur', Math.max(6, (row.scrollWidth - row.clientWidth) / 30) + 's');
      }
    });
    return row;
  },

  /**
   * 扫码登录：向宿主要一个授权链接，用系统浏览器打开让用户登录，然后轮询到登录成功。
   * 成功后刷新一次状态（歌词/按钮立即变可用）。
   */
  loginMusic() {
    if (this._musicLoginBusy) return;
    this._musicLoginBusy = true;
    // 先展开歌词条，让用户即使未登录也能看到反馈（否则条没开、提示无处显示像"没反应"）。
    this.showMusic();
    this.updateMusicTip('正在获取登录链接…');
    fetch(BASE + '/music/login/qr', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((qr) => {
        if (!qr || qr.ok === false || !qr.url || !qr.key) {
          this._musicLoginBusy = false;
          this.updateMusicTip('登录失败：' + ((qr && qr.message) || '无法获取授权链接'));
          this.showMusic();
          return;
        }
        if (window.petBridge && window.petBridge.openExternal) window.petBridge.openExternal(qr.url);
        this.updateMusicTip('已打开授权页，请在浏览器完成登录…');
        this.showMusic();
        const deadline = Date.now() + 5 * 60 * 1000;
        const tick = () => {
          if (Date.now() > deadline) {
            this._musicLoginBusy = false;
            this.updateMusicTip('登录超时，请重试');
            return;
          }
          const q = '?key=' + encodeURIComponent(qr.key) + '&anon=' + encodeURIComponent(qr.anonToken || '');
          fetch(BASE + '/music/login/poll' + q, { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then((res) => {
              if (res && res.ok && res.loggedIn) {
                this._musicLoginBusy = false;
                this.updateMusicTip('已登录成功');
                window.setTimeout(() => this.updateMusicTip(null), 1500);
                this.refreshMusicState();
                return;
              }
              window.setTimeout(tick, 2500);
            })
            .catch(() => window.setTimeout(tick, 3000));
        };
        window.setTimeout(tick, 1500);
      })
      .catch(() => {
        this._musicLoginBusy = false;
        this.updateMusicTip('登录失败：网络错误');
        this.showMusic();
      });
  },

  /** 立即拉一次状态并渲染（登录后刷新用）。 */
  refreshMusicState() {
    fetch(BASE + '/music/state', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => s && this.renderMusic(s))
      .catch(() => undefined);
  },

  /** 歌词锁定：开启后常驻显示（不再需要 hover），关闭后恢复 hover 显隐。 */
  setMusicLock(on) {
    this.musicLocked = !!on;
    if (this.musicLocked) {
      this.showMusic();
    } else if (!this.hoverBody) {
      this.hideMusicSoon();
    }
  },

  musicReasonText(reason) {
    switch (reason) {
      case 'disabled':
        return '网易云控制未启用';
      case 'unconfigured':
        return '请先在桌宠设置填写网易云凭证';
      case 'not-logged-in':
        return '请先在设置页扫码登录网易云';
      case 'no-client':
        return '未检测到网易云客户端';
      case 'no-lyric':
        return '这首歌暂无歌词';
      default:
        return '';
    }
  },
});
