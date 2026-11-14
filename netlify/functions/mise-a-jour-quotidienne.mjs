// Fonction planifiée Netlify : chaque matin, elle relance la construction du
// site. La construction exécute l'agent, qui va relire les annonces sur
// akorimmo.com : nouveaux biens ajoutés, biens vendus retirés, prix mis à jour.
//
// À faire une seule fois dans Netlify :
//   Site configuration > Build & deploy > Build hooks > « Add build hook »
//   puis copier l'adresse obtenue dans une variable d'environnement
//   nommée BUILD_HOOK_URL (Site configuration > Environment variables).
export default async () => {
  const hook = process.env.BUILD_HOOK_URL;
  if (!hook) {
    console.log('BUILD_HOOK_URL non définie : mise à jour automatique désactivée.');
    return new Response('BUILD_HOOK_URL manquante', { status: 200 });
  }
  const r = await fetch(hook, { method: 'POST', body: '{}' });
  console.log(`Reconstruction demandée à Netlify : HTTP ${r.status}`);
  return new Response('ok');
};

// Tous les jours à 5 h 50 (heure UTC, soit 6 h 50 en hiver, 7 h 50 en été à Paris). Les horaires sont décalés
// d'un site à l'autre pour ne pas solliciter akorimmo.com par plusieurs sites à la fois.
export const config = { schedule: '50 5 * * *' };
