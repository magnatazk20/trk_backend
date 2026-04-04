CREATE TABLE IF NOT EXISTS gift_vouchers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(150) NOT NULL,
  description TEXT NULL,
  image_url VARCHAR(500) NULL,
  price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  discount_coupon VARCHAR(80) NOT NULL,
  redeem_reward_value DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_gift_vouchers_discount_coupon (discount_coupon),
  KEY idx_gift_vouchers_active (is_active)
);

CREATE TABLE IF NOT EXISTS gift_voucher_purchases (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  gift_voucher_id BIGINT UNSIGNED NOT NULL,
  paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  discount_coupon VARCHAR(80) NOT NULL,
  redeem_reward_value DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  status ENUM('paid','cancelled') NOT NULL DEFAULT 'paid',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_gift_voucher_purchases_user (user_id),
  KEY idx_gift_voucher_purchases_voucher (gift_voucher_id)
);

INSERT INTO gift_vouchers
  (name, description, image_url, price, discount_coupon, redeem_reward_value, is_active)
VALUES
  ('Vale Presente Bronze', 'Vale básico para recompensas iniciais.', 'https://images.unsplash.com/photo-1512909006721-3d6018887383?q=80&w=1200&auto=format&fit=crop', 20.00, 'VALEBRONZE20', 25.00, 1),
  ('Vale Presente Prata', 'Vale intermediário com bônus melhor.', 'https://images.unsplash.com/photo-1549921296-3a6b5f9150a9?q=80&w=1200&auto=format&fit=crop', 50.00, 'VALEPRATA50', 62.00, 1),
  ('Vale Presente Ouro', 'Vale premium para maiores recompensas.', 'https://images.unsplash.com/photo-1607082350899-7e105aa886ae?q=80&w=1200&auto=format&fit=crop', 100.00, 'VALEOURO100', 130.00, 1)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description),
  image_url = VALUES(image_url),
  price = VALUES(price),
  redeem_reward_value = VALUES(redeem_reward_value),
  is_active = VALUES(is_active),
  updated_at = NOW();
