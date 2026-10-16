SELECT
  parent.name AS categoria_padre,
  child.name AS subcategoria,
  child.slug,
  child.is_active
FROM categories child
LEFT JOIN categories parent
  ON parent.id = child.parent_id
WHERE child.slug IN ('hpl','stratificato','meg','labgrade')
ORDER BY child.sort_order, child.name;

SELECT
  f.code,
  f.name AS family_name,
  parent.name AS parent_category,
  c.name AS category_name
FROM project_product_families f
LEFT JOIN categories c
  ON c.id = f.category_id
LEFT JOIN categories parent
  ON parent.id = c.parent_id
WHERE f.code = 'MEG';
