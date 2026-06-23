IWSDKでは、WebXRデバッグのため、なんと自己証明書を用いて自動的に開発サーバーのHTTPS化を行ってくれる。
(WebXR Device APIにはHTTPSが必須)

しかし、WebXRフロントエンドからなんらかの開発APIを呼び出したい場合、開発APIサーバーもHTTPS化しないと`Mixed Content`エラーとなる。

そこで、`vite`の`proxy`を使い、開発サーバーをHTTPS化する。

```typescript
server: {
  host: "0.0.0.0",
  port: 8081,
  open: true,
  proxy: {
    "/api": {
	  target: "http://localhost:8080/",
	  changeOrigin: true,
	},
  },
}
```

これで、/apiにアクセスすると、`http://localhost:8080/`にプロキシされる。
