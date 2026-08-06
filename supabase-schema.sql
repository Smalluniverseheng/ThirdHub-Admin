-- ===== ThirdHub × ThirdHub-Admin Supabase 数据库结构 =====
-- 在 Supabase SQL Editor 中执行本文件建表

-- 用户资料
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  nickname TEXT,
  avatar TEXT,
  level TEXT NOT NULL DEFAULT 'satellite',   -- guest/satellite/planet/star/galaxy/universe
  role TEXT NOT NULL DEFAULT 'user',          -- user/agent/admin
  expire_at TIMESTAMPTZ,
  storage_used BIGINT NOT NULL DEFAULT 0,
  invite_code TEXT UNIQUE,
  invited_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 会员等级配置（管理后台可改）
CREATE TABLE IF NOT EXISTS membership_levels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  storage_bytes BIGINT NOT NULL,
  price_month NUMERIC NOT NULL DEFAULT 0,
  sort INT NOT NULL DEFAULT 0
);
INSERT INTO membership_levels (id, name, storage_bytes, price_month, sort) VALUES
  ('guest', '游客', 0, 0, 0),
  ('satellite', '卫星', 104857600, 0, 1),
  ('planet', '行星', 1073741824, 29, 2),
  ('star', '恒星', 5368709120, 99, 3),
  ('galaxy', '星系', 21474836480, 199, 4),
  ('universe', '宇宙', -1, 399, 5)
ON CONFLICT (id) DO NOTHING;

-- Token 用量（统计用）
CREATE TABLE IF NOT EXISTS token_usage (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID REFERENCES profiles(id),
  provider TEXT,
  model TEXT,
  prompt_tokens INT DEFAULT 0,
  completion_tokens INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 订单
CREATE TABLE IF NOT EXISTS orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID REFERENCES profiles(id),
  level TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending/paid/refunded
  agent_id UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 代理分润
CREATE TABLE IF NOT EXISTS agent_commissions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id UUID REFERENCES profiles(id),
  order_id BIGINT REFERENCES orders(id),
  level_depth INT NOT NULL,                -- 1/2/3
  rate NUMERIC NOT NULL,                   -- 0.20/0.05/0.02
  amount NUMERIC NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending/settled/withdrawn
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_relations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id UUID REFERENCES profiles(id),
  sub_user_id UUID REFERENCES profiles(id),
  depth INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(agent_id, sub_user_id)
);

-- 卡密（50 位）
CREATE TABLE IF NOT EXISTS card_keys (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  card TEXT UNIQUE NOT NULL,               -- TP-XXXXXXXX-...
  level TEXT NOT NULL,                     -- 兑换后等级
  card_type TEXT NOT NULL DEFAULT 'month', -- month/quarter/year/forever
  used_by UUID REFERENCES profiles(id),
  used_at TIMESTAMPTZ,
  disabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 邀请码
CREATE TABLE IF NOT EXISTS invite_codes (
  code TEXT PRIMARY KEY,
  agent_id UUID REFERENCES profiles(id),
  uses INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 全局配置（限时免费模型等）
CREATE TABLE IF NOT EXISTS configs (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 审计日志
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id UUID,
  action TEXT,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 云端同步表（主站）
CREATE TABLE IF NOT EXISTS bookshelf (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  data JSONB,
  version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS reading_progress (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  data JSONB,
  version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS history (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  data JSONB,
  version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS favorites (
  id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  data JSONB,
  version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);

-- 系统更新推送
CREATE TABLE IF NOT EXISTS app_updates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'optional',   -- optional/force
  title TEXT,
  content TEXT,
  download_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== RLS（行级安全） =====
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookshelf ENABLE ROW LEVEL SECURITY;
ALTER TABLE reading_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE history ENABLE ROW LEVEL SECURITY;
ALTER TABLE favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_updates ENABLE ROW LEVEL SECURITY;

CREATE POLICY profiles_self ON profiles FOR ALL USING (auth.uid() = id);
CREATE POLICY bookshelf_self ON bookshelf FOR ALL USING (auth.uid() = user_id);
CREATE POLICY progress_self ON reading_progress FOR ALL USING (auth.uid() = user_id);
CREATE POLICY history_self ON history FOR ALL USING (auth.uid() = user_id);
CREATE POLICY favorites_self ON favorites FOR ALL USING (auth.uid() = user_id);
CREATE POLICY configs_read ON configs FOR SELECT USING (true);
CREATE POLICY updates_read ON app_updates FOR SELECT USING (true);

-- ===== 卡密兑换 RPC =====
CREATE OR REPLACE FUNCTION redeem_card(p_card TEXT, p_user UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  c card_keys%ROWTYPE;
  months INT;
BEGIN
  SELECT * INTO c FROM card_keys WHERE card = p_card AND disabled = false;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', '卡密不存在或已失效'); END IF;
  IF c.used_by IS NOT NULL THEN RETURN jsonb_build_object('error', '卡密已被使用'); END IF;

  months := CASE c.card_type WHEN 'month' THEN 1 WHEN 'quarter' THEN 3 WHEN 'year' THEN 12 ELSE 1200 END;

  UPDATE card_keys SET used_by = p_user, used_at = now() WHERE id = c.id;
  UPDATE profiles SET
    level = c.level,
    expire_at = GREATEST(COALESCE(expire_at, now()), now()) + (months || ' months')::INTERVAL
  WHERE id = p_user;

  RETURN jsonb_build_object('ok', true, 'level', c.level, 'type', c.card_type);
END;
$$;

-- 新用户自动建 profile
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO profiles (id, email, nickname) VALUES (NEW.id, NEW.email, split_part(NEW.email, '@', 1))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION handle_new_user();
