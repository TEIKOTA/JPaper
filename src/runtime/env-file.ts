// 契約付録 §5。.env の読み込み（プロセス入口専用）。
import path from "node:path";
import { JpaperError } from "../types/errors.js";

export const ENV_FILE_NAME = ".env";

// 秘密（API キー等）をシェル履歴に残さずに渡すための口。
//
// 呼ぶのはプロセス入口だけで、`runCli` やライブラリ経路からは呼ばない。ライブラリが
// 暗黙にファイルを読むと、同じ引数でもマシンによって結果が変わる＝テストが非決定になる。
//
// 既存の環境変数は上書きしない（process.loadEnvFile の仕様）。シェルや CI の明示指定が
// 常に勝つので、.env は「何も指定しなかったときの既定」として働く。
export function loadDotEnv(dir: string = process.cwd()): boolean {
  const file = path.join(dir, ENV_FILE_NAME);
  try {
    process.loadEnvFile(file);
    return true;
  } catch (e) {
    // 無いのが普通の状態。あるときだけ効く。
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    // 握るのは「無い」だけ。読めない .env を黙って無視すると、鍵が載らない理由が
    // 分からないまま「認証エラー」として遠くで出る。
    throw new JpaperError(2, "input", `${file} を読み込めません: ${(e as Error).message}`);
  }
}
