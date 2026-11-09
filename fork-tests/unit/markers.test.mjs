import {
  escapeXml, markersBalanced, hasMarkers, markersToXml, xmlToMarkers,
} from '../../shinkansen/fork/engines/markers.js';

describe('markers ↔ XML', () => {
  test('成對與單一標記轉成標籤，文字內容跳脫', () => {
    const src = 'See 【1】the <docs>【/1】 & 【*2】 more';
    const xml = markersToXml(src);
    expect(xml).toBe('See <x1>the &lt;docs&gt;</x1> &amp; <y2/> more');
    expect(xmlToMarkers(xml)).toBe(src);
  });

  test('巢狀標記可往返', () => {
    const src = '【1】a 【2】b【/2】 c【/1】';
    expect(markersBalanced(src)).toBe(true);
    expect(xmlToMarkers(markersToXml(src))).toBe(src);
  });

  test('標記不成對時只做跳脫，保留原本的 【】 寫法', () => {
    const src = '【1】open <b> without close';
    expect(markersBalanced(src)).toBe(false);
    expect(markersToXml(src)).toBe(escapeXml(src));
    expect(xmlToMarkers(markersToXml(src))).toBe(src);
  });

  test('服務改寫的單一標籤形式都接受', () => {
    expect(xmlToMarkers('a <y3 /> b')).toBe('a 【*3】 b');
    expect(xmlToMarkers('a <y3></y3> b')).toBe('a 【*3】 b');
    expect(xmlToMarkers('<x1 >x</x1 >')).toBe('【1】x【/1】');
  });

  test('hasMarkers 不受 RegExp lastIndex 影響', () => {
    expect(hasMarkers('【1】x【/1】')).toBe(true);
    expect(hasMarkers('【1】x【/1】')).toBe(true);
    expect(hasMarkers('plain text')).toBe(false);
  });

  test('實體字元還原', () => {
    expect(xmlToMarkers('Tom &amp; Jerry &lt;3 &quot;hi&quot; it&#39;s')).toBe('Tom & Jerry <3 "hi" it\'s');
  });
});
