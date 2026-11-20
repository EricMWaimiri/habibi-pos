-- Audited ordinary TEST runtime function correction; migration30 bytes/history preserved.
-- No ownership, privilege, SECURITY DEFINER or invariant changes.
BEGIN;
CREATE OR REPLACE FUNCTION goods_receipt_complete_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE rid uuid; h supplier_goods_receipts%ROWTYPE; i record; received numeric; valued numeric; original supplier_goods_receipts%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='supplier_goods_receipts' THEN
  rid:=NEW.id;
 ELSE
  rid:=NEW.receipt_id;
 END IF;
 SELECT * INTO STRICT h FROM supplier_goods_receipts WHERE id=rid;
 IF h.creation_xid<>pg_current_xact_id() THEN RAISE EXCEPTION 'Receipt lines must be sealed in the header transaction' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('invoice-receiving:'||h.purchase_id,0));
 IF NOT EXISTS(SELECT 1 FROM supplier_goods_receipt_lines WHERE receipt_id=rid) THEN RAISE EXCEPTION 'Receipt requires lines' USING ERRCODE='23514'; END IF;
 IF h.reverses_id IS NOT NULL THEN
  SELECT * INTO STRICT original FROM supplier_goods_receipts WHERE id=h.reverses_id;
  IF original.reverses_id IS NOT NULL OR original.purchase_id<>h.purchase_id
  OR (SELECT count(*) FROM supplier_goods_receipt_lines WHERE receipt_id=rid)<>(SELECT count(*) FROM supplier_goods_receipt_lines WHERE receipt_id=original.id)
  THEN RAISE EXCEPTION 'Invalid receipt reversal' USING ERRCODE='23514'; END IF;
 END IF;
 FOR i IN SELECT l.*,p."purchaseId",p."productId",p.quantity AS ordered,p."unitCost",m."productId" AS movement_product,m."quantityChange",m."quantityAfter",m."previousQty",m."purchaseItemId",m.type::text AS movement_type,m."userId"
 FROM supplier_goods_receipt_lines l JOIN purchase_items p ON p.id=l.purchase_item_id JOIN stock_movements m ON m.id=l.movement_id WHERE l.receipt_id=rid ORDER BY p.id LOOP
  IF i."purchaseId"<>h.purchase_id OR i."productId"<>i.movement_product OR i.quantity<>i."quantityChange"
   OR i."quantityAfter"-i."previousQty"<>i.quantity OR i."purchaseItemId" IS NOT NULL OR i."userId" IS DISTINCT FROM h.actor_id
   OR (i.quantity>0 AND i.movement_type<>'IN') OR (i.quantity<0 AND i.movement_type<>'OUT')
  THEN RAISE EXCEPTION 'Receipt/movement mismatch' USING ERRCODE='23514'; END IF;
  IF h.reverses_id IS NULL AND i.quantity<=0 THEN RAISE EXCEPTION 'Receipt quantity must be positive' USING ERRCODE='23514'; END IF;
  IF h.reverses_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM supplier_goods_receipt_lines o WHERE o.receipt_id=h.reverses_id AND o.purchase_item_id=i.purchase_item_id AND o.quantity=-i.quantity AND o.amount=-i.amount)
  THEN RAISE EXCEPTION 'Reversal must negate original lines exactly' USING ERRCODE='23514'; END IF;
  SELECT coalesce(sum(l.quantity),0),coalesce(sum(l.amount),0) INTO received,valued FROM supplier_goods_receipt_lines l WHERE l.purchase_item_id=i.purchase_item_id;
  IF received<0 OR received>i.ordered OR valued<>round(received*i."unitCost",2)
  THEN RAISE EXCEPTION 'Receipt exceeds authorized quantity or valuation does not reconcile' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
COMMIT;
