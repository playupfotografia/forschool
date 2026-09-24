// ============================================================================
// GET /api/registrar-ip
//
// Devolve o IP e a localizacao aproximada (por IP, sem pedir GPS do celular)
// de quem chamou. Usado pelo portal no momento da autorizacao de imagem, pra
// guardar no authorization_log de cada aluno de onde/de qual aparelho o
// responsavel assinou — da' mais peso ao registro se um dia for preciso
// provar que foi ele mesmo quem autorizou.
//
// So' le' headers que a propria Vercel ja' manda em toda requisicao (Edge
// Network) — sem banco, sem chave, sem servico externo. Localizacao e' por
// IP (cidade/estado/pais), nao GPS: nao pede permissao nenhuma ao navegador,
// entao nunca fica com buraco por o pai ter negado.
// ============================================================================

module.exports = async (req, res) => {
  const forwarded = req.headers['x-forwarded-for'] || '';
  const ip = (forwarded.split(',')[0] || req.socket?.remoteAddress || '').trim() || null;

  const city = req.headers['x-vercel-ip-city']
    ? decodeURIComponent(req.headers['x-vercel-ip-city'])
    : null;
  const region  = req.headers['x-vercel-ip-country-region'] || null;
  const country = req.headers['x-vercel-ip-country'] || null;

  res.status(200).json({ ip, city, region, country });
};
