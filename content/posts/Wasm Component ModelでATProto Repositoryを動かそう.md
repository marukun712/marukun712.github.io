この記事は、[Bluesky / ATProtocol Advent Calendar 2025](https://adventar.org/calendars/12255)15日目の記事です。

# はじめに
ATProtoを触っていると、一度や二度はブラウザでリポジトリを動かしたり、多言語でリポジトリを動かしたくなる時があるかと思います。

そこで、今回はWasmの力を使って多言語で動くATProto Repositoryを作っていきます。

# スキーマ定義
Wasm Component Modelでは、WIT(WebAssembly Interface Types)で、コンポーネント間のモジュールが扱うデータ型などを定義することができます。

ATProtoのリポジトリの基本的な操作ができるように、以下のようにスキーマ定義をします。

```
package polka:repository@0.1.0;

interface blockstore {
  read-block: func(
    cid: list<u8>
  ) -> list<u8>;

  write-block: func(
    codec: u64,
    hash: u64,
    contents: list<u8>
  ) -> list<u8>;
}

interface crypto {
  sign: func(bytes: list<u8>) -> list<u8>;
}

interface repo {
  record get-result {
    rpath: string,
    data: string
  }

  resource repo {
    get-cid: func(rpath: string) -> result<string, string>;
    get-record: func(rpath: string) -> result<get-result, string>;
    get-records: func(nsid: string) -> result<list<get-result>, string>;
    all-records: func() -> result<list<get-result>, string>;
    get-root: func() -> result<string, string>;

    create: func(rpath: string, data: string) -> result<string, string>;
    update: func(rpath: string, data: string) -> result<string, string>;
    delete: func(rpath: string) -> result<bool, string>;
  }

  create: func(did: string) -> result<repo, string>;
  open: func(did: string, cid: string) -> result<repo, string>;
}

world repository {
  import blockstore;
  import crypto;
  export repo;
}
```

ここで、肝となってくるのが、`import`という宣言です。
これは、Wasmのホスト側で実装するメソッドを宣言するためのもので、この例であれば、MSTルートへの署名処理と、リポジトリがつかうBlockstoreをホスト側で実装することができます。

これにより、署名やBlockstoreのロジックはホスト側の環境に合わせたものを使いながら、Wasm Component内で型安全に呼び出すことができます。

`wit-bindgen`というツールで、Rust用のコードを生成することができます。

```sh
wit-bindgen rust --out-dir src --default-bindings-module "crate::repository" --generate-all --world repository ./wit
```

# Rust実装

生成されたコードをもとに、リポジトリを実装していきます。
今回はATProtoのRust実装である`atrium`を使わせていただき、このように実装しました。

https://github.com/atrium-rs/atrium

```rust
mod repository;
mod wasip2_store;

use crate::repository::exports::polka::repository::repo::{GuestRepo, Repo};
use crate::repository::polka::repository::crypto;
use atrium_api::types::string::Did;
use atrium_crypto::{did::parse_did_key, verify::Verifier};
use cid::Cid;
use futures::TryStreamExt;
use futures::executor::block_on;
use repository::exports::polka::repository::repo;
use std::{cell::RefCell, str::FromStr};
use wasip2_store::Wasip2Blockstore;

struct HostRepo {
    repo: atrium_repo::Repository<Wasip2Blockstore>,
    did: String,
}

impl HostRepo {
    fn create(&mut self, rpath: String, data: String) -> Result<String, String> {
        let (commit_builder, cid) =
            block_on(async { self.repo.add_raw(&rpath, data).await }).map_err(|e| e.to_string())?;
        // このcrypto interfaceはホストが実装する
        let sig = crypto::sign(&commit_builder.bytes());
        // Commitを確定
        block_on(async { commit_builder.finalize(sig).await }).map_err(|e| e.to_string())?;
        // 検証
        let commit = self.repo.commit();
        match parse_did_key(&self.did) {
            Ok((alg, pub_key)) => {
                match Verifier::default().verify(alg, &pub_key, &commit.bytes(), &commit.sig()) {
                    Ok(_) => (),
                    Err(e) => return Err(e.to_string()),
                }
            }
            Err(e) => return Err(e.to_string()),
        }
        Ok(cid.to_string())
    }

    fn update(&mut self, rpath: String, data: String) -> Result<String, String> {
        let (commit_builder, cid) = block_on(async { self.repo.update_raw(&rpath, data).await })
            .map_err(|e| e.to_string())?;
        let sig = crypto::sign(&commit_builder.bytes());
        block_on(async { commit_builder.finalize(sig).await }).map_err(|e| e.to_string())?;
        let commit = self.repo.commit();
        match parse_did_key(&self.did) {
            Ok((alg, pub_key)) => {
                match Verifier::default().verify(alg, &pub_key, &commit.bytes(), &commit.sig()) {
                    Ok(_) => (),
                    Err(e) => return Err(e.to_string()),
                }
            }
            Err(e) => return Err(e.to_string()),
        }
        Ok(cid.to_string())
    }

    fn delete(&mut self, rpath: String) -> Result<bool, String> {
        let commit_builder =
            block_on(async { self.repo.delete_raw(&rpath).await }).map_err(|e| e.to_string())?;
        let sig = crypto::sign(&commit_builder.bytes());
        block_on(async { commit_builder.finalize(sig).await }).map_err(|e| e.to_string())?;
        let commit = self.repo.commit();
        match parse_did_key(&self.did) {
            Ok((alg, pub_key)) => {
                match Verifier::default().verify(alg, &pub_key, &commit.bytes(), &commit.sig()) {
                    Ok(_) => (),
                    Err(e) => return Err(e.to_string()),
                }
            }
            Err(e) => return Err(e.to_string()),
        }
        Ok(true)
    }

    fn get_cid(&mut self, rpath: String) -> Result<String, String> {
        let mut tree = self.repo.tree();
        let raw_cid = block_on(async { tree.get(&rpath).await });
        let cid = match raw_cid {
            Ok(v) => v,
            Err(e) => return Err(e.to_string()),
        };
        Ok(cid.unwrap().to_string())
    }

    fn get_record(&mut self, rpath: String) -> Result<repo::GetResult, String> {
        let record: Option<String> =
            block_on(async { self.repo.get_raw(&rpath).await }).map_err(|e| e.to_string())?;
        let data = record.ok_or("Record not found")?;
        Ok(repo::GetResult { rpath, data })
    }

    fn get_records(&mut self, nsid: String) -> Result<Vec<repo::GetResult>, String> {
        let mut tree = self.repo.tree();
        let stream = block_on(async { tree.entries_prefixed(&nsid).try_collect().await });
        let keys: Vec<(String, Cid)> = match stream {
            Ok(v) => v,
            Err(e) => return Err(e.to_string()),
        };
        let records = keys
            .iter()
            .map(|k| self.get_record(k.0.clone()))
            .collect::<Result<_, _>>()?;
        Ok(records)
    }

    fn all_records(&mut self) -> Result<Vec<repo::GetResult>, String> {
        let mut tree = self.repo.tree();
        let stream = block_on(async { tree.entries().try_collect().await });
        let keys: Vec<(String, Cid)> = match stream {
            Ok(v) => v,
            Err(e) => return Err(e.to_string()),
        };
        let records = keys
            .iter()
            .map(|k| self.get_record(k.0.clone()))
            .collect::<Result<_, _>>()?;
        Ok(records)
    }

    fn get_root(&mut self) -> Result<String, String> {
        Ok(self.repo.root().to_string())
    }
}

struct GuestRepoImpl {
    inner: RefCell<HostRepo>,
}

impl GuestRepo for GuestRepoImpl {
    fn create(&self, rpath: String, data: String) -> Result<String, String> {
        self.inner.borrow_mut().create(rpath, data)
    }

    fn update(&self, rpath: String, data: String) -> Result<String, String> {
        self.inner.borrow_mut().update(rpath, data)
    }

    fn delete(&self, rpath: String) -> Result<bool, String> {
        self.inner.borrow_mut().delete(rpath)
    }

    fn get_cid(&self, rpath: String) -> Result<String, String> {
        self.inner.borrow_mut().get_cid(rpath)
    }

    fn get_record(&self, rpath: String) -> Result<repo::GetResult, String> {
        self.inner.borrow_mut().get_record(rpath)
    }

    fn get_records(&self, nsid: String) -> Result<Vec<repo::GetResult>, String> {
        self.inner.borrow_mut().get_records(nsid)
    }

    fn all_records(&self) -> Result<Vec<repo::GetResult>, String> {
        self.inner.borrow_mut().all_records()
    }

    fn get_root(&self) -> Result<String, String> {
        self.inner.borrow_mut().get_root()
    }
}

struct Component;

impl repository::exports::polka::repository::repo::Guest for Component {
    type Repo = GuestRepoImpl;

    fn create(did: String) -> Result<repo::Repo, String> {
        let did_clone = did.clone();
        let parsed = match Did::new(did_clone) {
            Ok(v) => v,
            Err(e) => return Err(e.to_string()),
        };
        // blockstoreを生成
        let bs = Wasip2Blockstore::new();
        // CommitBuilderを取得
        let builder = block_on(async { atrium_repo::Repository::create(bs, parsed).await });
        let builder = match builder {
            Ok(v) => v,
            Err(e) => return Err(e.to_string()),
        };
        // このcrypto interfaceはホスト側が実装する
        let sig = crypto::sign(&builder.bytes());

        let repo = block_on(async { builder.finalize(sig).await });
        let repo = match repo {
            Ok(v) => v,
            Err(e) => return Err(e.to_string()),
        };
        let commit = repo.commit();
        match parse_did_key(&did) {
            Ok((alg, pub_key)) => {
                match Verifier::default().verify(alg, &pub_key, &commit.bytes(), &commit.sig()) {
                    Ok(_) => (),
                    Err(e) => return Err(e.to_string()),
                }
            }
            Err(e) => return Err(e.to_string()),
        }
        let guest_repo = GuestRepoImpl {
            inner: RefCell::new(HostRepo { repo, did }),
        };
        Ok(repo::Repo::new(guest_repo))
    }

    fn open(did: String, cid: String) -> Result<Repo, String> {
        let parsed_cid = match Cid::from_str(&cid) {
            Ok(v) => v,
            Err(e) => return Err(e.to_string()),
        };
        // blockstoreを生成
        let bs = wasip2_store::Wasip2Blockstore::new();
        // Repositoryを取得
        let repo = block_on(async { atrium_repo::Repository::open(bs, parsed_cid).await });
        let repo = match repo {
            Ok(v) => v,
            Err(e) => return Err(e.to_string()),
        };
        let commit = repo.commit();
        match parse_did_key(&did) {
            Ok((alg, pub_key)) => {
                match Verifier::default().verify(alg, &pub_key, &commit.bytes(), &commit.sig()) {
                    Ok(_) => (),
                    Err(e) => return Err(e.to_string()),
                }
            }
            Err(e) => return Err(e.to_string()),
        }
        let guest_repo = GuestRepoImpl {
            inner: RefCell::new(HostRepo { repo, did }),
        };
        Ok(repo::Repo::new(guest_repo))
    }
}

repository::export!(Component with_types_in repository);
```

生成されたコードで、`&self`がイミュータブルだったので、この記事を参考に`内部可変性パターン`というパターンで実装をしました。Rustむずかしい。
https://zenn.dev/chikoski/articles/wit-and-rust-resource

また、wasip2では非同期処理を扱えないので、block_onで実行しています。

Blockstoreは以下のように実装しました。
```rust
use crate::repository::polka::repository::blockstore;
use atrium_repo::blockstore::{AsyncBlockStoreRead, AsyncBlockStoreWrite, Error};
use ipld_core::cid::Cid;

pub struct Wasip2Blockstore;

impl Wasip2Blockstore {
    pub fn new() -> Self {
        Self {}
    }
}

impl AsyncBlockStoreRead for Wasip2Blockstore {
    async fn read_block_into(&mut self, cid: Cid, contents: &mut Vec<u8>) -> Result<(), Error> {
        let block = blockstore::read_block(&cid.to_bytes());
        contents.clear();
        contents.extend_from_slice(&block);
        Ok(())
    }
}

impl AsyncBlockStoreWrite for Wasip2Blockstore {
    async fn write_block(&mut self, codec: u64, hash: u64, contents: &[u8]) -> Result<Cid, Error> {
        let cid_bytes = blockstore::write_block(codec, hash, contents);
        let cid = Cid::try_from(cid_bytes.as_slice()).map_err(|_| Error::UnsupportedHash(hash))?;
        Ok(cid)
    }
}
```

`use crate::repository::polka::repository::blockstore;`というのが、wit定義でimportと宣言したblockstore interfaceになります。

# ビルド・Nodejsで実行

Wasm Componentをビルドします。

```sh
cargo build --target=wasm32-wasip2 --release
```

`repo.wasm`というファイルが生成されます。

それでは、生成されたWasm Componentを、Nodejsで実行してみましょう。

必要なパッケージをインストールします。

```sh
npm i @bytecodealliance/jco @bytecodealliance/preview2-shim
```

`jco`コマンドで、Wasm CompoentからTypeScript用の型定義を生成することができます。

```sh
npx jco transpile wasm/repo.wasm -o dist/transpiled --instantiation=async
```

順調に進んできましたが、ここで一つ問題があります。
前述したとおり、wasip2では非同期処理を扱うことができませんが、Nodejs用のBlockstore実装の多くが、非同期ベースで作成されています。

なので、atriumのCAR実装を参考に、同期処理ベースのCAR Blockstore `CarSyncStore`を実装しました。

```typescript
import { readFileSync, writeFileSync } from "node:fs";
import { decode, encode } from "@ipld/dag-cbor";
import { sha256 as createHash } from "@noble/hashes/sha2.js";
import { CID } from "multiformats";
import * as Digest from "multiformats/hashes/digest";
import { sha256 } from "multiformats/hashes/sha2";
import varint from "varint";

export const SHA2_256 = sha256.code;

export class CidNotFound extends Error {
	constructor() {
		super("CID not found");
	}
}

export class UnsupportedHash extends Error {
	constructor(code: number) {
		super(`Unsupported hash code: ${code}`);
	}
}

export type ErrorType = CidNotFound | UnsupportedHash;

// ATProtoはCAR v1を使っているらしいので、v1を使うことにするCAR
export class CarSyncStore {
	private path: string;
	private roots: CID[];
	private index: Map<string, { offset: number; length: number }>;

	constructor(path: string) {
		this.path = path;
		this.roots = [];
		this.index = new Map<string, { offset: number; length: number }>();
	}

	create() {
		// CAR V1 ヘッダー
		const header = {
			version: 1,
			roots: this.roots.map((cid) => cid.bytes),
		}; // DAG-CBORでエンコードする
		const headerEncoded = encode(header);
		// ヘッダーの長さを可変長整数でエンコードする
		const unsignedVarint = varint.encode(headerEncoded.length);
		//ファイルの書き込み
		writeFileSync(this.path, Buffer.from(unsignedVarint));
		writeFileSync(this.path, headerEncoded, { flag: "a" });
	}

	updateIndex() {
		this.index.clear();
		const data: Uint8Array = readFileSync(this.path);
		let offset = 0;

		// ヘッダー長を読み取る
		const headerLen = varint.decode(data, offset);
		if (!varint.decode.bytes) {
			throw new Error("Invalid header length");
		}
		offset += varint.decode.bytes;

		// ヘッダー本体を読み取る
		const headerBytes = data.slice(offset, offset + headerLen);
		offset += headerLen;
		const header: { version: number; roots: Uint8Array[] } =
			decode(headerBytes);
		this.roots = header.roots.map((r: Uint8Array) => CID.decode(r));

		while (offset < data.length) {
			// ブロック長
			const blockLen = varint.decode(data, offset);
			if (!varint.decode.bytes) {
				throw new Error("Invalid header length");
			}
			offset += varint.decode.bytes;
			// CID
			const slice = data.subarray(offset);
			const [cid, remainder] = CID.decodeFirst(slice);
			// 読み取った CID の長さだけ offset を進める
			offset += slice.length - remainder.length;
			// ブロック内容を取り出す
			const contentLen = blockLen - cid.bytes.length;
			const content = remainder.subarray(0, contentLen);
			// SHA-256検証
			if (cid.multihash.code === 0x12) {
				const digest = createHash(content);
				const encoded = Digest.create(SHA2_256, digest);
				const expectedCid = CID.create(1, cid.code, encoded);
				if (!cid.equals(expectedCid)) {
					throw new Error("Invalid block hash");
				}
			}
			// index登録
			this.index.set(cid.toString(), { offset, length: contentLen });
			offset += contentLen;
		}
	}

	updateHeaderRoots(newRoots: CID[]) {
		this.roots = newRoots;
		// CARヘッダーを再エンコード
		const header = {
			version: 1,
			roots: this.roots.map((cid) => cid.bytes),
		};
		const headerEncoded = encode(header);
		const headerLenVarint = varint.encode(headerEncoded.length);
		// ファイル全体を読み込む
		const data = readFileSync(this.path);
		// 既存ヘッダーの長さを読み取る
		let offset = 0;
		const oldHeaderLen = varint.decode(data, offset);
		if (!varint.decode.bytes) throw new Error("Invalid header length");
		offset += varint.decode.bytes;
		const oldHeaderTotalLen = offset + oldHeaderLen;
		const restOfFile = new Uint8Array(data).slice(oldHeaderTotalLen);
		// 新しいヘッダーを書き込む
		const newHeader = Buffer.concat([
			Buffer.from(headerLenVarint),
			Buffer.from(headerEncoded),
		]);
		// ファイルを上書き
		writeFileSync(this.path, Buffer.concat([newHeader, restOfFile]));
		// indexを更新
		this.updateIndex();
	}

	writeBlock(codec: number, hash: number, contents: Uint8Array): Uint8Array {
		if (hash !== SHA2_256) {
			throw new UnsupportedHash(hash);
		}
		// コンテンツからCIDを算出
		const digest = createHash(contents);
		const encoded = Digest.create(SHA2_256, digest);
		const cid = CID.create(1, codec, encoded);
		// セクションは | varint | CID | contents | の形式で構成される
		const blockBuffer = Buffer.from(contents);
		const cidBuffer = Buffer.from(cid.bytes);
		// ブロック全体の長さを可変長整数でエンコード
		// varintはCID + contentsの長さを表す
		const lengthVarint = varint.encode(blockBuffer.length + cidBuffer.length);
		const varintBuffer = Buffer.from(lengthVarint);
		const fileBuffer = readFileSync(this.path);
		// コンテンツが始まる場所を記録
		const contentOffset =
			fileBuffer.length + lengthVarint.length + cidBuffer.length;
		writeFileSync(this.path, varintBuffer, { flag: "a" });
		writeFileSync(this.path, cidBuffer, { flag: "a" });
		writeFileSync(this.path, blockBuffer, { flag: "a" });
		this.index.set(cid.toString(), {
			offset: contentOffset,
			length: contents.length,
		});
		return cid.bytes;
	}

	readBlock(cid: CID, out: Uint8Array[]) {
		// indexからブロックの開始バイトを取得
		const block = this.index.get(cid.toString());
		if (!block) {
			throw new CidNotFound();
		}
		out.length = 0;
		const data = readFileSync(this.path);
		const content = new Uint8Array(data).slice(
			block.offset,
			block.offset + block.length,
		);
		out.push(content);
	}

	getRoots() {
		return this.roots;
	}
}
```

この`CarSyncStore`を使って、TypeScript側で、このように呼び出すことができます。
```typescript
export async function init(sk: string, didKey: string) {
	// WASMのロード
	const loader = async (path: string) => {
		const buf = readFileSync(`./dist/transpiled/${path}`);
		return await WebAssembly.compile(new Uint8Array(buf));
	};

	const store = new CarSyncStore(path);

	// importする関数をバインド
	const wasm = await instantiate(loader, {
		//@ts-expect-error
		"polka:repository/crypto": {
			sign: (bytes: Uint8Array) => {
				const skBytes = hexToBytes(sk);
				const sig = secp256k1.sign(bytes, skBytes);
				return sig;
			},
		},
		"polka:repository/blockstore": {
			readBlock: (cid: Uint8Array) => {
				const parsed = CID.decode(cid);
				const out: Uint8Array[] = [];
				store.readBlock(parsed, out);
				if (!out[0]) throw new Error("Block not found.");
				return out[0];
			},
			writeBlock: (codec: bigint, hash: bigint, contents: Uint8Array) => {
				return store.writeBlock(Number(codec), Number(hash), contents);
			},
		},
		...new WASIShim().getImportObject<"0.2.6">(),
	});

	// repoを開く
	if (existsSync(path)) {
		store.updateIndex();
		const roots = store.getRoots();
		if (!roots[0]) throw new Error("Root not found.");
		return { repo: wasm.repo.open(didKey, roots[0].toString()), store };
	} else {
		store.create();
		const repo = wasm.repo.create(didKey);
		const root = repo.getRoot();
		store.updateHeaderRoots([CID.parse(root)]);
		return { repo, store };
	}
}
```

`repo`の型定義が自動生成されているため、`repo.getRecord(rpath)`のようなwitで定義したメソッドを型保管が効いた状態で呼び出すことができます。

# おわりに
最後までお読みいただき、ありがとうございました。


<iframe width="560" height="315" src="https://www.youtube.com/embed/LF8Kva-tIjM?si=N4Twa6hmHQmUDvg7" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>