// fork/i18n/fork-i18n.js — 驛傳（Ekiden）擴充頁面的字串與品牌名稱
//
// 載入位置：popup / options / translate-doc / 驛傳設定頁，緊接在 lib/i18n.js 之後（classic script）。
// 不修改上游 819 KB 的 lib/i18n.js，改為在執行期處理 lib/i18n.js 公開的 _tables：
//   1. 使用者看得到的「Shinkansen」改成「Ekiden」。**授權區塊（options.license.*）不改**，
//      上游的授權與版權聲明維持原文。網址一律是小寫 shinkansen，不受影響。
//   2. 加入驛傳自己的字串（8 種介面語言）。
//   3. 頁面微調：授權區塊下方加註「本擴充功能衍生自 Shinkansen」、設定頁加驛傳設定入口、
//      隱藏上游 iOS App Store 推廣（驛傳不提供 iOS 版）。

(function (global) {
  'use strict';
  const i18n = global.__SK && global.__SK.i18n;
  if (!i18n || !i18n._tables || i18n.__ekidenPatched) return;
  i18n.__ekidenPatched = true;

  const BRAND = 'Ekiden';
  const FORK_REPO = 'https://github.com/yongjer/shinkansen';
  const UPSTREAM_REPO = 'https://github.com/jimmysu0309/shinkansen';
  const PROTECTED_PREFIXES = ['options.license.'];

  const intro = (home, upstream, notes, readme, version) =>
    `<a href="${FORK_REPO}" target="_blank" rel="noopener">${home}</a>（${upstream}）· `
    + `<a href="${FORK_REPO}/blob/main/docs/FORK-NOTES.md" target="_blank" rel="noopener">${notes}</a> · `
    + `<a href="${UPSTREAM_REPO}#readme" target="_blank" rel="noopener">${readme}</a> · `
    + `<span id="options-version" class="options-version">${version || ''}</span>`;

  const STRINGS = {
    'zh-TW': {
      'fork.brand': '驛傳 Ekiden',
      'fork.options.link': '驛傳設定：更多翻譯服務、引擎備援、雲端備份 →',
      'fork.attribution.html': `驛傳 Ekiden 是 <a href="${UPSTREAM_REPO}" target="_blank" rel="noopener">Shinkansen</a> 的衍生版本，由 <a href="${FORK_REPO}" target="_blank" rel="noopener">yongjer/shinkansen</a> 維護，同樣依 Elastic License 2.0 散布。上方為原作的授權與作者資訊。`,
      'options.intro.html': intro('驛傳專案頁', `以 <a href="${UPSTREAM_REPO}" target="_blank" rel="noopener">Shinkansen</a> 為基礎`, '驛傳說明', '原版使用說明'),
    },
    'zh-CN': {
      'fork.brand': '驿传 Ekiden',
      'fork.options.link': '驿传设置：更多翻译服务、引擎备援、云端备份 →',
      'fork.attribution.html': `驿传 Ekiden 是 <a href="${UPSTREAM_REPO}" target="_blank" rel="noopener">Shinkansen</a> 的衍生版本，由 <a href="${FORK_REPO}" target="_blank" rel="noopener">yongjer/shinkansen</a> 维护，同样依 Elastic License 2.0 分发。上方为原作的授权与作者信息。`,
      'options.intro.html': intro('驿传项目页', `基于 <a href="${UPSTREAM_REPO}" target="_blank" rel="noopener">Shinkansen</a>`, '驿传说明', '原版使用说明'),
    },
    en: {
      'fork.brand': 'Ekiden',
      'fork.options.link': 'Ekiden settings: more translation services, engine fallback, cloud backup →',
      'fork.attribution.html': `Ekiden is a derivative of <a href="${UPSTREAM_REPO}" target="_blank" rel="noopener">Shinkansen</a>, maintained at <a href="${FORK_REPO}" target="_blank" rel="noopener">yongjer/shinkansen</a> and distributed under the same Elastic License 2.0. The license and author details above are those of the original work.`,
      'options.intro.html': intro('Ekiden project page', `based on <a href="${UPSTREAM_REPO}" target="_blank" rel="noopener">Shinkansen</a>`, 'Ekiden notes', 'Original user guide'),
    },
    ja: {
      'fork.brand': '駅伝 Ekiden',
      'fork.options.link': 'Ekiden の設定：翻訳サービスの追加、エンジンのフォールバック、クラウドバックアップ →',
      'fork.attribution.html': `Ekiden は <a href="${UPSTREAM_REPO}" target="_blank" rel="noopener">Shinkansen</a> の派生版で、<a href="${FORK_REPO}" target="_blank" rel="noopener">yongjer/shinkansen</a> が保守し、同じく Elastic License 2.0 で配布しています。上記は原作のライセンスと作者情報です。`,
      'options.intro.html': intro('Ekiden プロジェクトページ', `<a href="${UPSTREAM_REPO}" target="_blank" rel="noopener">Shinkansen</a> がベース`, 'Ekiden の説明', '原版の使い方'),
    },
    ko: {
      'fork.brand': 'Ekiden',
      'fork.options.link': 'Ekiden 설정: 번역 서비스 추가, 엔진 대체 순서, 클라우드 백업 →',
      'fork.attribution.html': `Ekiden은 <a href="${UPSTREAM_REPO}" target="_blank" rel="noopener">Shinkansen</a>의 파생판으로, <a href="${FORK_REPO}" target="_blank" rel="noopener">yongjer/shinkansen</a>에서 관리하며 동일하게 Elastic License 2.0으로 배포됩니다. 위 내용은 원작의 라이선스와 저작자 정보입니다.`,
      'options.intro.html': intro('Ekiden 프로젝트 페이지', `<a href="${UPSTREAM_REPO}" target="_blank" rel="noopener">Shinkansen</a> 기반`, 'Ekiden 안내', '원본 사용 설명'),
    },
    es: {
      'fork.brand': 'Ekiden',
      'fork.options.link': 'Ajustes de Ekiden: más servicios de traducción, motores de respaldo, copia en la nube →',
      'fork.attribution.html': `Ekiden es un derivado de <a href="${UPSTREAM_REPO}" target="_blank" rel="noopener">Shinkansen</a>, mantenido en <a href="${FORK_REPO}" target="_blank" rel="noopener">yongjer/shinkansen</a> y distribuido bajo la misma Elastic License 2.0. La licencia y el autor indicados arriba son los de la obra original.`,
      'options.intro.html': intro('Página del proyecto Ekiden', `basado en <a href="${UPSTREAM_REPO}" target="_blank" rel="noopener">Shinkansen</a>`, 'Notas de Ekiden', 'Guía original'),
    },
    fr: {
      'fork.brand': 'Ekiden',
      'fork.options.link': 'Paramètres d’Ekiden : plus de services de traduction, moteurs de secours, sauvegarde cloud →',
      'fork.attribution.html': `Ekiden est un dérivé de <a href="${UPSTREAM_REPO}" target="_blank" rel="noopener">Shinkansen</a>, maintenu sur <a href="${FORK_REPO}" target="_blank" rel="noopener">yongjer/shinkansen</a> et distribué sous la même Elastic License 2.0. La licence et l’auteur indiqués ci-dessus sont ceux de l’œuvre originale.`,
      'options.intro.html': intro('Page du projet Ekiden', `basé sur <a href="${UPSTREAM_REPO}" target="_blank" rel="noopener">Shinkansen</a>`, 'Notes d’Ekiden', 'Guide d’origine'),
    },
    de: {
      'fork.brand': 'Ekiden',
      'fork.options.link': 'Ekiden-Einstellungen: weitere Übersetzungsdienste, Ausweich-Engines, Cloud-Backup →',
      'fork.attribution.html': `Ekiden ist ein Derivat von <a href="${UPSTREAM_REPO}" target="_blank" rel="noopener">Shinkansen</a>, gepflegt unter <a href="${FORK_REPO}" target="_blank" rel="noopener">yongjer/shinkansen</a> und ebenfalls unter der Elastic License 2.0 verbreitet. Lizenz und Autor oben gelten für das Originalwerk.`,
      'options.intro.html': intro('Ekiden-Projektseite', `basiert auf <a href="${UPSTREAM_REPO}" target="_blank" rel="noopener">Shinkansen</a>`, 'Ekiden-Hinweise', 'Originalanleitung'),
    },
  };

  const tables = i18n._tables;
  for (const [lang, dict] of Object.entries(tables)) {
    if (!dict) continue;
    for (const key of Object.keys(dict)) {
      if (PROTECTED_PREFIXES.some((p) => key.startsWith(p))) continue;
      const v = dict[key];
      if (typeof v === 'string' && v.indexOf('Shinkansen') !== -1) {
        dict[key] = v.replace(/Shinkansen/g, BRAND);
      }
    }
    if (STRINGS[lang]) Object.assign(dict, STRINGS[lang]);
  }

  // ── 頁面微調（本檔在 body 末端執行，上方 DOM 已解析完成）──────────────
  const doc = global.document;
  if (!doc) return;

  // 上游 iOS App Store 推廣不適用於驛傳
  const style = doc.createElement('style');
  style.textContent = '#ios-promo, #ios-promo-banner { display: none !important; }';
  (doc.head || doc.documentElement).appendChild(style);

  // 設定頁：說明段落下方加驛傳設定入口；授權區塊下方加衍生作品聲明
  const introEl = doc.querySelector('p[data-i18n-html="options.intro.html"]');
  if (introEl && !doc.getElementById('ekiden-settings-link')) {
    const p = doc.createElement('p');
    p.className = 'ekiden-settings-link';
    const a = doc.createElement('a');
    a.id = 'ekiden-settings-link';
    a.href = '../fork/pages/settings.html';
    a.setAttribute('data-i18n', 'fork.options.link');
    a.textContent = STRINGS['zh-TW']['fork.options.link'];
    a.style.fontWeight = '600';
    p.appendChild(a);
    introEl.insertAdjacentElement('afterend', p);
  }
  const license = doc.querySelector('section.license-section');
  if (license && !doc.getElementById('ekiden-attribution')) {
    const p = doc.createElement('p');
    p.id = 'ekiden-attribution';
    p.className = 'muted';
    p.setAttribute('data-i18n-html', 'fork.attribution.html');
    license.appendChild(p);
  }

  // popup：版本號連到驛傳的更新紀錄
  const ver = doc.getElementById('version');
  if (ver && /jimmysu0309\.github\.io/.test(ver.getAttribute('href') || '')) {
    ver.setAttribute('href', `${FORK_REPO}/blob/main/CHANGELOG.md`);
  }
})(typeof window !== 'undefined' ? window : globalThis);
