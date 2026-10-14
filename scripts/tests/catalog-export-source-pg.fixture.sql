
insert into brands values('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','Clevite');
insert into suppliers values('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','Supplier 1',now()),('00000000-0000-0000-0000-000000000013','00000000-0000-0000-0000-000000000001','Supplier 2',now());
insert into supplier_current_price_pointers values
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000004'),
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000013','00000000-0000-0000-0000-000000000015','00000000-0000-0000-0000-000000000014');
insert into supplier_price_publications(id,organization_id,brand_id,supplier_id,release_id,status) select publication_id,organization_id,brand_id,supplier_id,release_id,'published' from supplier_current_price_pointers;
insert into supplier_price_release_rows(id,release_id,normalized_code,product_code,description,buy_price,currency,valid_from,row_status) values
(1,'00000000-0000-0000-0000-000000000005','61/1','61/1','Slash 1',100,'EUR',current_date-1,'accepted'),
(2,'00000000-0000-0000-0000-000000000005','611','611','Compact',50,'EUR',current_date-1,'accepted'),
(3,'00000000-0000-0000-0000-000000000005','61/1','61/1','Future cheaper',1,'EUR',current_date+1,'accepted'),
(4,'00000000-0000-0000-0000-000000000005','USD','USD','wrong currency',1,'USD',current_date-1,'accepted'),
(5,'00000000-0000-0000-0000-000000000005','ZERO','ZERO','zero',0,'EUR',current_date-1,'accepted'),
(6,'00000000-0000-0000-0000-000000000005','REJECT','REJECT','rejected',1,'EUR',current_date-1,'rejected'),
(7,'00000000-0000-0000-0000-000000000015','61/1','61/1','Slash 2',90,'EUR',current_date-1,'accepted'),
(8,'00000000-0000-0000-0000-000000000005','BROKEN','BAD','mismatched normalized identity',1,'EUR',current_date-1,'accepted');
insert into catalog_products(id,organization_id,brand_id,product_code,normalized_code,description) values
('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','61/1','611','CAT SLASH'),
('00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','611','611','CAT COMPACT');
