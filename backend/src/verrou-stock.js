// Les opérations qui modifient le stock (ajout d'un import, sortie, rangement automatique,
// changement d'emplacement) passent une par une, grâce à un verrou MySQL nommé.
// Sans ce verrou, deux validations au même moment peuvent provoquer un interblocage (deadlock)
// et une erreur pour l'un des utilisateurs. Le magasin traite peu d'opérations par minute :
// les faire attendre quelques millisecondes ne se remarque pas.

const ATTENTE_MAX_SECONDES = 20;

// Le nom inclut la base, pour qu'une base de test ne bloque pas la base réelle
async function verrouillerStock(connexion) {
  const [[{ ok }]] = await connexion.query("SELECT GET_LOCK(CONCAT(DATABASE(), '_stock'), ?) AS ok", [
    ATTENTE_MAX_SECONDES,
  ]);
  if (ok !== 1) {
    const err = new Error('Le stock est occupé par une autre opération : réessayez dans un instant');
    err.status = 503;
    throw err;
  }
}

async function libererStock(connexion) {
  try {
    await connexion.query("SELECT RELEASE_LOCK(CONCAT(DATABASE(), '_stock'))");
  } catch {
    // la connexion est rendue au pool juste après ; le verrou tombe si elle est fermée
  }
}

module.exports = { verrouillerStock, libererStock };
