# Fixtures DummyJSON

Derivadas dos seis JSONs reais em `temp/dummyjson_responses/`, sem alterar os originais.
O script original consulta categories via `/products/category-list` (array de slugs),
e nao `/products/categories` (array de objetos).

- Envelopes preservam total, skip e limit observados; paginas foram reduzidas a dois
  produtos para manter fixtures pequenas. O mock HTTP ajusta skip/limit ao pedido.
- products inclui um produto sem brand, observado na resposta original.
- product_1 preserva os campos consumidos pelo provider e um preco externo para
  testar que ele nao e propagado.
- As reviews reais foram substituidas por uma review sintetica com email .invalid;
  os testes garantem que nem mesmo essa review e devolvida/persistida.
- Outros campos nao utilizados foram removidos. Estas fixtures nao sao acessadas
  pelo codigo de producao.
