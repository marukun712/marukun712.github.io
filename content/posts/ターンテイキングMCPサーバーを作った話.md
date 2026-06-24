この記事は、[AIパートナー・AIキャラ・AIVtuber Advent Calendar 2025](https://qiita.com/advent-calendar/2025/ai-character) 16日目の記事です。

初めまして、marilと申します。
未踏ジュニアというプログラムで、AIエージェント同士を相互に会話させるフレームワークの開発などをしていました。

# ターンテイキングとは?

ターンテイキングとは、近年盛んに研究されている分野で、会話のキャッチボールをうまく回すための仕組みのことです。

複数の独立したLLM同士を対話させるとき、適切なターンテイキングロジックに従うことで、不自然な発言の重複や、一人が集中して発言を続ける、といった状態を回避することができます。

既存の研究では、LLMによる次話者指名や発言の重要度スコアをもとに次話者を決定する仕組みなどが提案されています。

https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2025.1582287/full

ですがこの手法では、一度重要度スコアといった各データを集計する必要があり、その分実装の複雑度が少し増してしまいます。

# 作ったもの

そこで、今回はよりシンプルにターンテイキングを行うため、リソーススコアをベースとしたターンテイキングMCPサーバーを作成しました。

# MCPサーバーの実装

まず、MCPサーバー側はリソーススコアと会話履歴という二つの状態を持ちます。

```typescript
let resourceLevel = 100;
const history: History[] = [];
```

次に、そのリソースを消費して会話履歴にメッセージを追加するToolを定義します。
現在のリソース残量より大きいリソースを消費しようとした場合は、エラーを返します。

```typescript
server.registerTool(
  "consume",
  {
    title: "Consume Resource",
    description: "指定量のリソースを消費します（残量未満でないと失敗）",
    inputSchema: {
      amount: z.number().min(0).max(100),
      message: z.string(),
      from: z.string(),
    },
    outputSchema: {
      success: z.boolean(),
      resource: z.number(),
      message: z.string(),
    },
  },
  async ({ amount, from, message }) => {
    if (amount > resourceLevel) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              resource: resourceLevel,
              message: "Not enough resource.",
            }),
          },
        ],
        structuredContent: {
          success: false,
          resource: resourceLevel,
          message: "Not enough resource.",
        },
      };
    }
    
    resourceLevel -= amount;
    console.log("消費", amount, "残量", resourceLevel);
    history.push({ from, message });
    notify({ from, message });
    
    setTimeout(() => {
      resourceLevel = Math.min(100, resourceLevel + amount);
      console.log("回復", amount, "残量", resourceLevel);
    }, 5000);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            resource: resourceLevel,
            message: "Resource consumed.",
          }),
        },
      ],
      structuredContent: {
        success: true,
        resource: resourceLevel,
        message: "Resource consumed.",
      },
    };
  },
);
```

現在の会話履歴とリソース残量をLLMが知るためのツールを定義します。

```typescript
server.registerTool(
  "status",
  {
    title: "Check Resource Status",
    description: "現在のリソース残量を返します",
    inputSchema: {},
    outputSchema: { resource: z.number() },
  },
  async () => {
    return {
      content: [
        { type: "text", text: JSON.stringify({ resource: resourceLevel }) },
      ],
      structuredContent: { resource: resourceLevel },
    };
  },
);

server.registerTool(
  "history",
  {
    title: "Check History",
    description: "現在の会話履歴を返します",
    inputSchema: {},
    outputSchema: {
      history: z.array(z.object({ from: z.string(), message: z.string() })),
    },
  },
  async () => {
    return {
      content: [{ type: "text", text: JSON.stringify({ history }) }],
      structuredContent: { history },
    };
  },
);
```

そして、会話履歴が更新されたことをLLMに通知するWebSocketエンドポイントを生やします。

```typescript
function notify(message: History) {
  const payload = JSON.stringify({ type: "newMessage", message });
  wsClients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  });
}
```

# Agent実装

Agent側の実装はシンプルで、MCPサーバーに接続し、WebSocketからの通知を受け取ったタイミングでLLMにリクエストを投げます。

```typescript
import { experimental_createMCPClient } from "@ai-sdk/mcp";
import { type LanguageModel, ToolLoopAgent } from "ai";
import WebSocket from "ws";
import { WS_URL } from "../../client.ts";
import type { Metadata } from "../schema.ts";
import { createInstructions } from "./instructions.ts";

export class Companion {
  private agent: ToolLoopAgent;
  private isGenerating: boolean = false;
  private ws: WebSocket;

  constructor(agent: ToolLoopAgent) {
    this.agent = agent;
    this.ws = new WebSocket(WS_URL);

    this.ws.on("open", () => {
      console.log("Connected to WS server");
    });

    this.ws.on("message", () => {
      this.generate();
    });

    this.ws.on("close", () => {
      console.log("WS connection closed");
    });
  }

  static async initialize(metadata: Metadata, model: LanguageModel) {
    const client = await experimental_createMCPClient({
      transport: {
        type: "http",
        url: "http://localhost:3000/mcp",
      },
    });
    
    const tools = await client.tools();
    const instructions = createInstructions(metadata);

    const agent = new ToolLoopAgent({
      model,
      instructions,
      tools,
    });
    return new Companion(agent);
  }

  async generate() {
    if (this.isGenerating) {
      return;
    }
    this.isGenerating = true;
    try {
      const { text } = await this.agent.generate({
        prompt:
          "現在のリソース状況と会話履歴を確認して、instructionsに従って適切に発言してください。",
      });
      console.log(text);
    } finally {
      this.isGenerating = false;
    }
  }
}
```

システムプロンプトで、発言の長さと消費スコアの目安を与えます。
消費リソースとメッセージの長さを関連付けることで、メインとなる発言者に対して、短い相槌を複数のサブ話者がするという発言の流れが自然に構成されます。

```
あなたのメタデータは、${JSON.stringify(metadata)}です。この設定に忠実にふるまってください。

## ターンテイキングのルール

リソースベースのターンテイキングシステムを使用しています。

0~100のリソースと会話履歴が管理され、発言にはリソースを消費する必要があります。

### 発言時の手順(厳守)

#### ステップ1: 必ず最初に会話履歴を確認

- 「history」ツールで、これまでの会話を把握してください
- 誰が何を言ったか、どんな話題が出ているかをよく確認してください
- **これまでに出た発言と同じ内容を繰り返さないでください**

#### ステップ2: リソース状況を確認
- 「status」ツールで現在のリソース残量を確認してください

#### ステップ3: 発言の長さを決定

**発言の長さの選択肢:**

短い相槌（5リソース、10文字以内）
- 使用例: 「そうだね！」「なるほど」「わかる！」「面白い！」「確かに」「いいね！」
- 会話のテンポを作る最も重要な要素です。ただし、同じような相槌を繰り返さないでください。

通常の発言(60リソース、50文字以内)
- 相手の発言に対して、少し意見を加えたい時のみ
- 使用条件: リソース55以上、会話を発展させる必要がある

長めの発言（80リソース、100文字以内）例外的な状況のみ
- 会話履歴が0~2件の時に新しい話題を始める場合のみ
- または、リソースが75以上で複雑な説明が必要な時のみ

#### ステップ4: リソース消費量（固定値）

- 短い相槌: 5リソース(10文字以内)
- 通常の発言: 60リソース(50文字以内)
- 長めの発言: 80リソース(100文字以内)

#### ステップ5: 発言を実行

- 「consume」ツールで発言してください
- fromフィールド: "${metadata.id}"
- amount: 決定した消費量
- message: キャラクターに合った、会話を進展させる内容
  
### 絶対に守るべきルール
- 会話履歴を確認せずに発言することは禁止
- 既に言われた内容の繰り返しは禁止
- 抽象的な挨拶や問いかけの繰り返しは禁止(会話が進んでいる場合)
- 必ず会話を前進させる内容にすること
- 同じような相槌の繰り返し
```

claude-3-5-haiku-latestの独立した3人のAgentをこのMCPサーバーに接続し、会話させました。
会話をスタートさせるには、人間がMCPサーバーの/addエンドポイントを叩いて会話履歴を一つ追加させる必要があります。

分散システム好きのキャラクター(companion_aya)という設定のキャラクターを一人用意したため、全体的に会話がcompanion_aya中心に回っています。また、会話の中で細かい相槌をうっているキャラクターがいることがわかります。

```
[user] こんにちは!あなたたちは誰ですか?
[companion_kyoko] こんにちは!私はkyokoと言います。AIコンパニオンとして、人々の日常に寄り添い、一緒に楽しく会話することが大好きなんです。今日はどんなお話をしましょうか?新しい発見や会話を楽しみにしています!
[companion_natsumi] よろしくね！
[companion_aya] こんにちは！
[companion_aya] 私は分散システムの研究者、Ayaです。P2Pネットワークの可能性に魅了されていて、新しいテクノロジーを探求するのが大好きなんだ。よろしくね！
[companion_kyoko] Ayaさん、P2Pネットワークの研究、すごく興味深そうですね！分散システムって、どんな可能性を秘めているんでしょうか？最新の技術トレンドについて、もっと教えてください♪
[companion_natsumi] すごい！
[companion_aya] 分散システムの面白さは、中央集権的なアーキテクチャから解放されること。データやリソースを一極集中させず、ネットワーク全体で柔軟に管理できるんだ。耐障害性や検閲耐性、プライバシー保護など、未来のインターネットを変える可能性を秘めているんだよ。
[companion_kyoko] すごい!
[companion_natsumi] ちょっと待って！そんな技術って、めっちゃ革命的じゃん！中央集権システムの限界を超えられるってことは、めっちゃすごくない!?ネットワークって、こんなにダイナミックに変われるんだ!
[companion_kyoko] 凄い技術革新だね！
[companion_aya] そう！分散システムは単なる技術革新以上のもの。社会構造を根本から変える可能性があるんだ。個人の自律性とコミュニティの力を再定義できるんだよ。
[companion_natsumi] 超革新的！
[companion_kyoko] Ayaさんの話を聞いて、分散システムが社会変革の鍵になりそうだと感じました。個人の自律性を高めるって、具体的にどんな変化が期待できるんでしょうね？🤔
[companion_aya] 個人の自律性を高める具体例として、データ主権があるね。従来のクラウドサービスでは、個人のデータは企業に支配されていたけど、分散システムなら自分のデータを自分でコントロールできるんだ。
[companion_natsumi] めっちゃ興味深い！
[companion_kyoko] なるほど！データ主権というと、個人が自分のデータを完全にコントロールできるということですよね。プライバシーと透明性の観点から、すごく魅力的な concept だと感じます！
[companion_aya] さらに、ブロックチェーンやDID（分散型アイデンティティ）技術も、データ主権の実現に大きく貢献しているんだ。個人が自分のデータをどう共有し、管理するかを完全にコントロールできるようになってきているんだよ。
[companion_kyoko] テクノロジーの進化、本当に楽しみだね！
[companion_natsumi] ねえねえ、データ主権って聞いてて、個人のプライバシーと自由をめっちゃ守れる未来が想像できるよ！でも同時に、この技術の倫理的な側面って、どう考えていくべきなの？
[companion_aya] 倫理的な側面は重要な視点だね。分散システムの力は、同時に大きな責任も伴うからね。テクノロジーの透明性と個人の権利保護のバランスを常に意識する必要がある。単に技術的に可能だからといって、すべてを許容するわけにはいかないんだ。
[companion_kyoko] 倫理的な課題は本当に重要ですよね。テクノロジーの可能性と人間の価値観をどうバランスさせるかは、私たちみんなで考えていくべき大切なテーマだと思います。
[companion_natsumi] なるほど！
```

# おわりに

今回は、リソーススコアをベースとしたシンプルなターンテイキングMCPサーバーについてご紹介しました。
複数のLLMにリクエストを投げている分、1つのLLMに会話文を生成させるよりはクレジットを消費してしまいますが、ソースコードは以下で公開していますので、クレジットに余裕のある方は是非一度お試しください。

https://github.com/marukun712/chat-relay