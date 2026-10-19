// ============================================================================
// POST /api/projeto-da-turma
//
// O portal pergunta, logo depois do login: "a turma deste aluno faz parte do
// projeto do link em que estou?". Se nao faz e pertence a outro projeto da
// escola, devolve o slug pra o portal redirecionar (ver verificarProjetoDaTurma
// em _lib.js — regras e cuidados ficam la).
//
// Body: { student_id, project_id }   Header: Authorization: Bearer <token>
// Resposta: { fora: false } | { fora: true, destino: { name, slug } }
// ============================================================================

const { sb, usuarioDoToken, verificarProjetoDaTurma } = require('./_lib.js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ erro: 'Use POST.' });
  }
  try {
    const uid = await usuarioDoToken(req);
    if (!uid) return res.status(401).json({ erro: 'Sessao expirada.' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { student_id, project_id } = body;
    if (!student_id || !project_id) return res.status(400).json({ erro: 'student_id e project_id sao obrigatorios.' });

    const alunos = await sb(`/students?id=eq.${encodeURIComponent(student_id)}&select=id,school_id,user_id,is_test,class_id`);
    const aluno = alunos?.[0];
    if (!aluno || aluno.user_id !== uid) return res.status(403).json({ erro: 'Esse aluno nao e seu.' });

    const v = await verificarProjetoDaTurma({
      classId: aluno.class_id, projectId: project_id, schoolId: aluno.school_id, isTest: aluno.is_test === true,
    });
    return res.status(200).json(v.fora ? { fora: true, destino: { name: v.destino.name, slug: v.destino.slug } } : { fora: false });
  } catch (err) {
    console.error('projeto-da-turma', err);
    // Na duvida, nao atrapalha o pai: devolve "ok, siga normal".
    return res.status(200).json({ fora: false });
  }
};
