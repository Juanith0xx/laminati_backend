SELECT id,code,name,application,default_core,is_active FROM project_product_families ORDER BY name;
SELECT f.code,fmt.label,fmt.length_cm,fmt.width_cm FROM project_product_families f JOIN project_family_formats fmt ON fmt.family_id=f.id WHERE f.code='MEG' ORDER BY fmt.sort_order;
SELECT f.code,finish.name FROM project_product_families f JOIN project_family_finishes finish ON finish.family_id=f.id WHERE f.code='MEG' ORDER BY finish.sort_order;
SELECT f.code,t.thickness_mm FROM project_product_families f JOIN project_family_thicknesses t ON t.family_id=f.id WHERE f.code='MEG' ORDER BY t.sort_order;
SELECT column_name FROM information_schema.columns WHERE table_name='products' AND column_name IN ('commercial_mode','project_family_id') ORDER BY column_name;
