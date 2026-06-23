この記事は、[麻布麻衣 Advent Calendar](https://adventar.org/calendars/12627) 1日目の記事です。
テスト投稿を兼ねています。
# やること
必殺マイマイモード きゅんを(いろいろなMultibaseでエンコードしてから)デコードしちゃえ

# Multibaseってなに
バイナリをテキストとして表現するbase〇〇(base64,base58 etc...)の先頭にそれぞれに対応したプレフィックスをつけて、どのbase〇〇かわかるようにしたもの。

# base58btc

```typescript
import { base58btc } from "multiformats/bases/base58";

const base = base58btc;
const str = "きゅん";
const encoded = base.encode(new TextEncoder().encode(str));
console.log(encoded);
const decoded = new TextDecoder().decode(base.decode(encoded));
console.log(decoded);
```

```
z3txf2td7mbdUN
きゅん
```

# base2

```
0111000111000000110001101111000111000001010000101111000111000001010010011
きゅん
```

# base64

```
m44GN44KF44KT
きゅん
```

# base256emoji

```
🚀👆🌺🎵👆🎂🖕👆🎂😫
きゅん
```

# base10

```
94196746272484408656531
きゅん
```

# おわりに

<iframe width="560" height="315" src="https://www.youtube.com/embed/b_CAZeJlSos?si=1LxIIizsmG14Y2Ft" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>

とにかく、神曲なので聞いてください。
こちら、神曲です。(ほの氏感)
