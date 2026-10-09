-- ══════════════════════════════════════════════════════════════════════════════
-- OneDelivery v2 — MySQL Schema
-- Run: node src/config/migrate.js
-- Or:  mysql -u root -p onedelivery < src/config/schema.sql
-- ══════════════════════════════════════════════════════════════════════════════

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- ─── USERS ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  name                VARCHAR(120) NOT NULL DEFAULT '',
  email               VARCHAR(200) NOT NULL UNIQUE,
  phone               VARCHAR(20)  DEFAULT '',
  password_hash       VARCHAR(255) DEFAULT NULL,   -- null = OAuth only
  role                ENUM('customer','seller','driver','admin') NOT NULL DEFAULT 'customer',
  profile_image       TEXT         DEFAULT '',
  expo_push_token     VARCHAR(200) DEFAULT NULL,
  fcm_token           TEXT         DEFAULT NULL,
  google_id           VARCHAR(64)  DEFAULT NULL,   -- set when signed in with Google
  is_active           TINYINT(1)   NOT NULL DEFAULT 1,
  email_verified      TINYINT(1)   NOT NULL DEFAULT 0,
  phone_verified      TINYINT(1)   NOT NULL DEFAULT 0,
  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_users_email  (email),
  INDEX idx_users_role   (role),
  INDEX idx_users_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── REFRESH TOKENS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  user_id    CHAR(36)     NOT NULL,
  token_hash VARCHAR(255) NOT NULL UNIQUE,
  expires_at DATETIME     NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_rt_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── SELLER PROFILES ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS seller_profiles (
  id                   CHAR(36)     NOT NULL PRIMARY KEY,
  user_id              CHAR(36)     NOT NULL UNIQUE,
  shop_name            VARCHAR(120) NOT NULL DEFAULT '',
  shop_description     TEXT         DEFAULT '',
  shop_phone           VARCHAR(20)  DEFAULT '',
  shop_address         TEXT         DEFAULT '',
  shop_lat             DECIMAL(10,8) DEFAULT NULL,
  shop_lng             DECIMAL(11,8) DEFAULT NULL,
  shop_image           TEXT         DEFAULT '',
  bank_name            VARCHAR(100) DEFAULT '',
  bank_account_name    VARCHAR(120) DEFAULT '',
  bank_account_number  VARCHAR(40)  DEFAULT '',
  mobile_money_number  VARCHAR(20)  DEFAULT '',
  plan                 VARCHAR(50)  NOT NULL DEFAULT 'seller_free',
  balance              DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  total_sales          DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  rating               DECIMAL(3,2) NOT NULL DEFAULT 0.00,
  total_reviews        INT          NOT NULL DEFAULT 0,
  is_approved          TINYINT(1)   NOT NULL DEFAULT 0,
  created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_sp_approved (is_approved)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── SELLER APPLICATIONS ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS seller_applications (
  id                   CHAR(36)     NOT NULL PRIMARY KEY,
  user_id              CHAR(36)     NOT NULL UNIQUE,
  business_name        VARCHAR(120) NOT NULL,
  business_description TEXT         DEFAULT '',
  business_phone       VARCHAR(20)  DEFAULT '',
  business_address     TEXT         DEFAULT '',
  business_type        VARCHAR(60)  DEFAULT 'general',
  owner_name           VARCHAR(120) DEFAULT '',
  shop_lat             DECIMAL(10,8) DEFAULT NULL,
  shop_lng             DECIMAL(11,8) DEFAULT NULL,
  id_document_url      TEXT         DEFAULT '',
  tin_number           VARCHAR(30)  DEFAULT '',
  status               ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  rejection_reason     TEXT         DEFAULT '',
  reviewed_by          CHAR(36)     DEFAULT NULL,
  reviewed_at          DATETIME     DEFAULT NULL,
  created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_sa_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── DRIVER PROFILES ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS driver_profiles (
  id                  CHAR(36)     NOT NULL PRIMARY KEY,
  user_id             CHAR(36)     NOT NULL UNIQUE,
  vehicle_type        ENUM('bodaboda','bajaj','pickup','toyo') NOT NULL DEFAULT 'bodaboda',
  plate_number        VARCHAR(20)  NOT NULL DEFAULT '',
  vehicle_color       VARCHAR(40)  DEFAULT '',
  vehicle_model       VARCHAR(60)  DEFAULT '',
  license_number      VARCHAR(40)  DEFAULT '',
  id_document_url     TEXT         DEFAULT '',
  license_document_url TEXT        DEFAULT '',
  vehicle_photo_url   TEXT         DEFAULT '',
  driver_photo_url    TEXT         DEFAULT '',
  is_approved         TINYINT(1)   NOT NULL DEFAULT 0,
  is_online           TINYINT(1)   NOT NULL DEFAULT 0,
  current_lat         DECIMAL(10,8) DEFAULT NULL,
  current_lng         DECIMAL(11,8) DEFAULT NULL,
  heading             DECIMAL(6,2) DEFAULT 0,
  last_seen           DATETIME     DEFAULT NULL,
  rating              DECIMAL(3,2) NOT NULL DEFAULT 0.00,
  total_reviews       INT          NOT NULL DEFAULT 0,
  total_trips         INT          NOT NULL DEFAULT 0,
  total_earnings      DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  balance             DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  bank_name           VARCHAR(100) DEFAULT '',
  bank_account_name   VARCHAR(120) DEFAULT '',
  bank_account_number VARCHAR(40)  DEFAULT '',
  mobile_money_number VARCHAR(20)  DEFAULT '',
  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_dp_approved (is_approved),
  INDEX idx_dp_online   (is_online),
  INDEX idx_dp_vehicle  (vehicle_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── DRIVER APPLICATIONS ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS driver_applications (
  id                   CHAR(36)     NOT NULL PRIMARY KEY,
  user_id              CHAR(36)     NOT NULL UNIQUE,
  vehicle_type         ENUM('bodaboda','bajaj','pickup','toyo') NOT NULL,
  plate_number         VARCHAR(20)  NOT NULL DEFAULT '',
  vehicle_color        VARCHAR(40)  DEFAULT '',
  vehicle_model        VARCHAR(60)  DEFAULT '',
  license_number       VARCHAR(40)  DEFAULT '',
  national_id          VARCHAR(40)  DEFAULT '',
  id_document_url      TEXT         DEFAULT '',
  license_document_url TEXT         DEFAULT '',
  vehicle_photo_url    TEXT         DEFAULT '',
  driver_photo_url     TEXT         DEFAULT '',
  latra_sticker_url    TEXT         DEFAULT '',
  mobile_money_name    VARCHAR(120) DEFAULT '',
  mobile_money_number  VARCHAR(20)  DEFAULT '',
  mobile_money_network VARCHAR(30)  DEFAULT '',
  home_address         TEXT         DEFAULT '',
  city                 VARCHAR(80)  DEFAULT 'Dar es Salaam',
  status               ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  rejection_reason     TEXT         DEFAULT '',
  reviewed_by          CHAR(36)     DEFAULT NULL,
  reviewed_at          DATETIME     DEFAULT NULL,
  created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_da_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── CATEGORIES ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  name       VARCHAR(80)  NOT NULL UNIQUE,
  icon       VARCHAR(60)  DEFAULT 'grid-outline',
  color      VARCHAR(10)  DEFAULT '#64748B',
  image_url  TEXT         DEFAULT '',
  sort_order INT          NOT NULL DEFAULT 99,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_cat_sort (sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── PRODUCTS ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id               CHAR(36)      NOT NULL PRIMARY KEY,
  seller_id        CHAR(36)      DEFAULT NULL,
  seller_name      VARCHAR(120)  NOT NULL DEFAULT 'OneDelivery',
  category_id      CHAR(36)      DEFAULT NULL,
  name             VARCHAR(200)  NOT NULL,
  description      TEXT          NOT NULL DEFAULT '',
  price            DECIMAL(12,2) NOT NULL,
  stock            INT           NOT NULL DEFAULT 0,
  images           JSON          DEFAULT NULL,
  status           ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  rejection_reason TEXT          DEFAULT '',
  avg_rating       DECIMAL(3,2)  NOT NULL DEFAULT 0.00,
  total_reviews    INT           NOT NULL DEFAULT 0,
  is_featured      TINYINT(1)    NOT NULL DEFAULT 0,
  featured_until   DATETIME      DEFAULT NULL,
  created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (seller_id)   REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  INDEX idx_prod_status    (status),
  INDEX idx_prod_seller    (seller_id),
  INDEX idx_prod_category  (category_id),
  INDEX idx_prod_featured  (is_featured, featured_until),
  FULLTEXT idx_prod_search (name, description)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── ADDRESSES ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS addresses (
  id             CHAR(36)     NOT NULL PRIMARY KEY,
  user_id        CHAR(36)     NOT NULL,
  label          VARCHAR(40)  NOT NULL DEFAULT 'Home',
  full_name      VARCHAR(120) NOT NULL DEFAULT '',
  street_address VARCHAR(200) NOT NULL DEFAULT '',
  city           VARCHAR(80)  NOT NULL DEFAULT '',
  region         VARCHAR(80)  DEFAULT '',
  phone_number   VARCHAR(20)  DEFAULT '',
  lat            DECIMAL(10,8) DEFAULT NULL,
  lng            DECIMAL(11,8) DEFAULT NULL,
  is_default     TINYINT(1)   NOT NULL DEFAULT 0,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_addr_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── CART ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cart_items (
  id         CHAR(36) NOT NULL PRIMARY KEY,
  user_id    CHAR(36) NOT NULL,
  product_id CHAR(36) NOT NULL,
  quantity   INT      NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cart (user_id, product_id),
  FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── WISHLIST ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wishlist (
  user_id    CHAR(36) NOT NULL,
  product_id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, product_id),
  FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── ORDERS ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id               CHAR(36)      NOT NULL PRIMARY KEY,
  user_id          CHAR(36)      NOT NULL,
  seller_id        CHAR(36)      DEFAULT NULL,
  status           ENUM('awaiting_payment','pending','processing','shipped','delivered','cancelled')
                                 NOT NULL DEFAULT 'awaiting_payment',
  subtotal         DECIMAL(12,2) NOT NULL DEFAULT 0,
  shipping_cost    DECIMAL(12,2) NOT NULL DEFAULT 0,
  tax              DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_price      DECIMAL(12,2) NOT NULL DEFAULT 0,
  shipping_address JSON          DEFAULT NULL,
  payment_method   ENUM('mobile','card') NOT NULL DEFAULT 'mobile',
  payment_provider VARCHAR(30)   DEFAULT 'snippe',
  payment_ref      VARCHAR(100)  DEFAULT NULL,
  payment_status   ENUM('pending','processing','success','failed') NOT NULL DEFAULT 'pending',
  payer_phone      VARCHAR(20)   DEFAULT '',
  notes            TEXT          DEFAULT '',
  paid_at          DATETIME      DEFAULT NULL,
  shipped_at       DATETIME      DEFAULT NULL,
  delivered_at     DATETIME      DEFAULT NULL,
  cancelled_at     DATETIME      DEFAULT NULL,
  created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)   REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_order_user    (user_id),
  INDEX idx_order_seller  (seller_id),
  INDEX idx_order_status  (status),
  INDEX idx_order_payref  (payment_ref),
  INDEX idx_order_paystat (payment_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── ORDER ITEMS ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_items (
  id         CHAR(36)      NOT NULL PRIMARY KEY,
  order_id   CHAR(36)      NOT NULL,
  product_id CHAR(36)      DEFAULT NULL,
  name       VARCHAR(200)  NOT NULL DEFAULT '',
  price      DECIMAL(12,2) NOT NULL DEFAULT 0,
  quantity   INT           NOT NULL DEFAULT 1,
  image      TEXT          DEFAULT '',
  FOREIGN KEY (order_id)   REFERENCES orders(id)   ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
  INDEX idx_oi_order (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── RIDE REQUESTS (DELIVERY) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ride_requests (
  id               CHAR(36)      NOT NULL PRIMARY KEY,
  customer_id      CHAR(36)      NOT NULL,
  driver_id        CHAR(36)      DEFAULT NULL,
  order_id         CHAR(36)      DEFAULT NULL,
  vehicle_type     ENUM('bodaboda','bajaj','pickup','toyo') NOT NULL DEFAULT 'bodaboda',
  status           ENUM('searching','accepted','going_to_shop','picked_up','on_the_way','delivered','cancelled','no_driver')
                                 NOT NULL DEFAULT 'searching',
  pickup_lat       DECIMAL(10,8) NOT NULL,
  pickup_lng       DECIMAL(11,8) NOT NULL,
  pickup_address   TEXT          DEFAULT '',
  dropoff_lat      DECIMAL(10,8) NOT NULL,
  dropoff_lng      DECIMAL(11,8) NOT NULL,
  dropoff_address  TEXT          DEFAULT '',
  fare             DECIMAL(10,2) NOT NULL DEFAULT 0,       -- agreed price (the customer's offer until a driver is chosen)
  suggested_fare   DECIMAL(10,2) DEFAULT NULL,             -- Bolt-style calculated price
  offered_fare     DECIMAL(10,2) DEFAULT NULL,             -- the customer's current offer
  payment_method   VARCHAR(10)   NOT NULL DEFAULT 'mobile',-- 'mobile' (in the app) or 'cash' (to the driver)
  distance_km      DECIMAL(8,2)  NOT NULL DEFAULT 0,
  route_polyline   TEXT          DEFAULT '',
  route_distance_m INT           DEFAULT NULL,
  route_duration_s INT           DEFAULT NULL,
  dispatch_wave    TINYINT       NOT NULL DEFAULT 0,
  dispatched_at    DATETIME      DEFAULT NULL,
  searching_since  DATETIME      DEFAULT NULL,
  delivery_fee_paid TINYINT(1)   NOT NULL DEFAULT 0,
  delivery_payment_ref VARCHAR(100) DEFAULT NULL,
  cancelled_reason TEXT          DEFAULT '',
  driver_rating    TINYINT(1)    DEFAULT NULL,
  driver_review    TEXT          DEFAULT NULL,
  accepted_at      DATETIME      DEFAULT NULL,
  going_to_shop_at DATETIME      DEFAULT NULL,
  picked_up_at     DATETIME      DEFAULT NULL,
  on_the_way_at    DATETIME      DEFAULT NULL,
  delivered_at     DATETIME      DEFAULT NULL,
  cancelled_at     DATETIME      DEFAULT NULL,
  created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (driver_id)   REFERENCES driver_profiles(id) ON DELETE SET NULL,
  FOREIGN KEY (order_id)    REFERENCES orders(id) ON DELETE SET NULL,
  INDEX idx_rr_customer (customer_id),
  INDEX idx_rr_driver   (driver_id),
  INDEX idx_rr_status   (status),
  INDEX idx_rr_order    (order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── RIDE OFFERS (which nearby drivers a delivery was offered to) ─────────────
CREATE TABLE IF NOT EXISTS ride_offers (
  ride_id        CHAR(36)     NOT NULL,
  driver_id      CHAR(36)     NOT NULL,              -- driver_profiles.id
  driver_user_id CHAR(36)     NOT NULL,              -- users.id (socket room / push target)
  wave           TINYINT      NOT NULL DEFAULT 1,
  distance_km    DECIMAL(8,2) NOT NULL DEFAULT 0,    -- driver → pickup when offered
  status         ENUM('offered','countered','accepted','declined','taken','expired','released','rejected') NOT NULL DEFAULT 'offered',
  counter_fare   DECIMAL(10,2) DEFAULT NULL,         -- the driver's own price, if they countered
  offered_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  countered_at   DATETIME     DEFAULT NULL,
  responded_at   DATETIME     DEFAULT NULL,
  PRIMARY KEY (ride_id, driver_id),
  INDEX idx_ro_driver (driver_id, status),
  INDEX idx_ro_status (ride_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── DRIVER EARNINGS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS driver_earnings (
  id           CHAR(36)      NOT NULL PRIMARY KEY,
  driver_id    CHAR(36)      NOT NULL,
  ride_id      CHAR(36)      DEFAULT NULL,
  amount       DECIMAL(10,2) NOT NULL DEFAULT 0,
  type         ENUM('delivery','bonus','adjustment') NOT NULL DEFAULT 'delivery',
  description  VARCHAR(200)  DEFAULT '',
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (driver_id) REFERENCES driver_profiles(id) ON DELETE CASCADE,
  INDEX idx_de_driver (driver_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── WITHDRAWALS ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS withdrawals (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  user_id        CHAR(36)      NOT NULL,
  user_role      ENUM('seller','driver') NOT NULL,
  amount         DECIMAL(12,2) NOT NULL,
  method         ENUM('mobile_money','bank') NOT NULL DEFAULT 'mobile_money',
  account_number VARCHAR(40)   NOT NULL DEFAULT '',
  account_name   VARCHAR(120)  DEFAULT '',
  bank_name      VARCHAR(100)  DEFAULT '',
  snippe_payout_ref VARCHAR(100) DEFAULT NULL,
  status         ENUM('pending','processing','completed','failed') NOT NULL DEFAULT 'pending',
  failure_reason TEXT          DEFAULT NULL,
  processed_at   DATETIME      DEFAULT NULL,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  INDEX idx_wd_user   (user_id),
  INDEX idx_wd_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── REVIEWS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reviews (
  id           CHAR(36)  NOT NULL PRIMARY KEY,
  user_id      CHAR(36)  NOT NULL,
  product_id   CHAR(36)  DEFAULT NULL,
  driver_id    CHAR(36)  DEFAULT NULL,
  ride_id      CHAR(36)  DEFAULT NULL,
  rating       TINYINT   NOT NULL,
  comment      TEXT      DEFAULT '',
  is_hidden    TINYINT(1) NOT NULL DEFAULT 0,
  admin_note   TEXT      DEFAULT NULL,
  created_at   DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)    REFERENCES users(id)           ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id)        ON DELETE CASCADE,
  FOREIGN KEY (driver_id)  REFERENCES driver_profiles(id) ON DELETE CASCADE,
  INDEX idx_rev_product (product_id),
  INDEX idx_rev_driver  (driver_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── CONVERSATIONS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id         CHAR(36)  NOT NULL PRIMARY KEY,
  type       ENUM('user_seller','user_admin','seller_admin','user_driver','seller_driver')
                       NOT NULL DEFAULT 'user_seller',
  order_id   CHAR(36)  DEFAULT NULL,
  ride_id    CHAR(36)  DEFAULT NULL,
  created_at DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_conv_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id CHAR(36) NOT NULL,
  user_id         CHAR(36) NOT NULL,
  unread_count    INT      NOT NULL DEFAULT 0,
  last_read_at    DATETIME DEFAULT NULL,
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)         REFERENCES users(id)         ON DELETE CASCADE,
  INDEX idx_cp_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS messages (
  id              CHAR(36)  NOT NULL PRIMARY KEY,
  conversation_id CHAR(36)  NOT NULL,
  sender_id       CHAR(36)  NOT NULL,
  body            TEXT      NOT NULL,
  type            ENUM('text','image','system') NOT NULL DEFAULT 'text',
  image_url       TEXT      DEFAULT NULL,
  is_read         TINYINT(1) NOT NULL DEFAULT 0,
  created_at      DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id)       REFERENCES users(id)         ON DELETE CASCADE,
  INDEX idx_msg_conv (conversation_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── NOTIFICATIONS ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  user_id    CHAR(36)     NOT NULL,
  title      VARCHAR(200) NOT NULL,
  body       TEXT         NOT NULL,
  type       VARCHAR(60)  NOT NULL DEFAULT 'general',
  data       JSON         DEFAULT NULL,
  is_read    TINYINT(1)   NOT NULL DEFAULT 0,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_notif_user   (user_id, is_read),
  INDEX idx_notif_created(created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── PACKAGES (admin-defined subscription plans) ──────────────────────────────
CREATE TABLE IF NOT EXISTS packages (
  id               VARCHAR(60)   NOT NULL PRIMARY KEY,
  name             VARCHAR(100)  NOT NULL,
  type             ENUM('customer','seller','driver') NOT NULL DEFAULT 'seller',
  price            DECIMAL(10,2) NOT NULL DEFAULT 0,
  duration_days    INT           NOT NULL DEFAULT 30,
  features         JSON          NOT NULL,
  is_free          TINYINT(1)    NOT NULL DEFAULT 0,
  is_active        TINYINT(1)    NOT NULL DEFAULT 1,
  sort_order       INT           NOT NULL DEFAULT 99,
  created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── SUBSCRIPTIONS ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id             CHAR(36)      NOT NULL PRIMARY KEY,
  user_id        CHAR(36)      NOT NULL,
  package_id     VARCHAR(60)   NOT NULL,
  amount         DECIMAL(12,2) NOT NULL DEFAULT 0,
  status         ENUM('pending','active','failed','expired','cancelled') NOT NULL DEFAULT 'pending',
  payment_ref    VARCHAR(100)  DEFAULT NULL,
  payment_method ENUM('mobile','card') NOT NULL DEFAULT 'mobile',
  activated_at   DATETIME      DEFAULT NULL,
  expires_at     DATETIME      DEFAULT NULL,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_sub_user    (user_id),
  INDEX idx_sub_status  (status),
  INDEX idx_sub_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── PROCESSED WEBHOOKS (deduplication) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS processed_webhooks (
  event_id   VARCHAR(100) NOT NULL PRIMARY KEY,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pw_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── AUDIT LOGS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id         CHAR(36)     NOT NULL PRIMARY KEY,
  user_id    CHAR(36)     DEFAULT NULL,
  action     VARCHAR(100) NOT NULL,
  entity     VARCHAR(60)  DEFAULT NULL,
  entity_id  CHAR(36)     DEFAULT NULL,
  ip_address VARCHAR(45)  DEFAULT NULL,
  details    JSON         DEFAULT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_user   (user_id),
  INDEX idx_audit_action (action),
  INDEX idx_audit_entity (entity, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── SEED DEFAULT CATEGORIES ──────────────────────────────────────────────────
INSERT IGNORE INTO categories (id, name, icon, color, sort_order) VALUES
  (UUID(), 'Electronics',  'hardware-chip-outline',   '#3B82F6', 1),
  (UUID(), 'Fashion',      'shirt-outline',           '#EC4899', 2),
  (UUID(), 'Food',         'fast-food-outline',       '#EF4444', 3),
  (UUID(), 'Beauty',       'sparkles-outline',        '#A855F7', 4),
  (UUID(), 'Sports',       'fitness-outline',         '#22C55E', 5),
  (UUID(), 'Books',        'book-outline',            '#F59E0B', 6),
  (UUID(), 'Furniture',    'bed-outline',             '#14B8A6', 7),
  (UUID(), 'Toys',         'game-controller-outline', '#F97316', 8);

-- ─── SEED DEFAULT PACKAGES ────────────────────────────────────────────────────
INSERT IGNORE INTO packages (id, name, type, price, duration_days, features, is_free, sort_order) VALUES
  ('customer_basic',   'Basic',   'customer', 0,     30, '["Standard shipping","Basic support"]', 1, 1),
  ('customer_premium', 'Premium', 'customer', 9900,  30, '["Free shipping","Priority support","Early access deals"]', 0, 2),
  ('customer_vip',     'VIP',     'customer', 24900, 30, '["Free shipping always","Dedicated support","Flash sale access","5% cashback"]', 0, 3),
  ('seller_free',      'Starter', 'seller',   0,     30, '["Up to 10 products","Standard listing","Basic analytics"]', 1, 1),
  ('seller_growth',    'Growth',  'seller',   19900, 30, '["Unlimited products","Featured listing priority","Advanced analytics","Chat support"]', 0, 2),
  ('seller_pro',       'Pro',     'seller',   49900, 30, '["Unlimited products","Top featured placement","Full analytics","Dedicated manager","Promoted in app"]', 0, 3);

-- ─── PUSH TOKENS ─────────────────────────────────────────────────────────────
-- One row per device + app, so a user signed in on several phones, or in both
-- the shop and driver apps, gets every notification meant for each of them.
CREATE TABLE IF NOT EXISTS push_tokens (
  token      VARCHAR(255) NOT NULL PRIMARY KEY,
  user_id    CHAR(36)     NOT NULL,
  app        VARCHAR(20)  DEFAULT NULL,   -- 'shop' | 'driver' (NULL = older app versions)
  platform   VARCHAR(10)  DEFAULT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_push_tokens_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SELECT 'OneDelivery MySQL schema applied ✅' AS result;
