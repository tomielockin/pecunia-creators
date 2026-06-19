# Pecunia · Plateforme créateurs (version partagée)

Plateforme multi-utilisateurs pour gérer la rémunération des créateurs UGC : chaque créateur se connecte depuis son appareil, dépose ses vidéos, déclare ses vues pendant une fenêtre mensuelle ; toi (compte maître) tu valides et tu paies. Données partagées en temps réel via Supabase.

**Pile technique :** site statique (HTML/CSS/JS, sans build) + **Supabase** (authentification + base Postgres + sécurité par lignes RLS). Hébergeable gratuitement sur GitHub + Cloudflare Pages.

---

## Ce dont tu as besoin (gratuit)

- Un compte **GitHub** (édition + versionnage, plus tard avec VS Code + Claude).
- Un compte **Supabase** (base de données + connexion des créateurs).
- Un compte **Cloudflare** (ou Netlify) pour l'hébergement.
- *(Optionnel)* une **clé API YouTube Data v3** pour relever les vues YouTube automatiquement.

---

## Étape 1 — Créer le projet Supabase

1. Va sur supabase.com → **New project**. Choisis un nom, un mot de passe de base de données (note-le), une région proche (Europe).
2. Attends ~2 minutes que le projet soit prêt.

## Étape 2 — Installer la base de données

1. Dans Supabase : menu **SQL Editor** → **New query**.
2. Ouvre le fichier `supabase/schema.sql`, copie tout, colle, clique **Run**.
3. Tu dois voir « Success ». (Le script est ré-exécutable sans risque.)

## Étape 3 — Réglage de l'authentification

Dans **Authentication → Sign In / Providers** (ou **Settings**) :

- Pour un démarrage sans friction, **désactive la confirmation par email** (« Confirm email » → off). Les créateurs pourront se connecter immédiatement après inscription.
- Si tu préfères garder la confirmation par email, laisse-la : les créateurs recevront un mail de validation (pense alors à renseigner le **Site URL**, étape 7).

## Étape 4 — Connecter l'app à Supabase

1. Dans Supabase : **Project Settings → API**.
2. Copie **Project URL** et la clé **anon / public**.
3. Ouvre `config.js` et remplace les deux valeurs.

> La clé **anon** est publique par conception : elle peut figurer dans le code et sur GitHub. Ce sont les règles RLS qui protègent les données. **Ne mets jamais la clé `service_role`** dans le code.

## Étape 5 — Créer TON compte maître

1. Ouvre l'application (en local : voir étape 6, ou directement après déploiement).
2. Clique **Créer un compte**, inscris-toi avec ton email + mot de passe. Tu seras d'abord un « créateur en attente », c'est normal.
3. Reviens dans Supabase → **SQL Editor**, et lance (avec ton email) :

   ```sql
   update public.profiles set role = 'admin', approved = true
   where id = (select id from auth.users where email = 'TON_EMAIL');
   ```

4. Déconnecte-toi / reconnecte-toi : tu as maintenant la console maître complète.

## Étape 6 — Tester en local (facultatif)

Ne double-clique pas le fichier (`file://` peut bloquer certains appels). Sers-le :

```bash
# avec Node installé
npx serve .
# ou avec Python
python3 -m http.server 8000
```

Puis ouvre l'adresse indiquée (ex. http://localhost:3000). Dans VS Code, l'extension **Live Server** fait pareil en un clic.

## Étape 7 — Mettre en ligne (GitHub + Cloudflare Pages)

1. Crée un dépôt GitHub et pousse ce dossier :

   ```bash
   git init
   git add .
   git commit -m "Plateforme Pecunia créateurs"
   git branch -M main
   git remote add origin https://github.com/TON-COMPTE/pecunia-creators.git
   git push -u origin main
   ```

2. Sur **Cloudflare** → **Workers & Pages → Create → Pages → Connect to Git**, choisis le dépôt.
   - **Build command** : *(laisser vide)*
   - **Build output directory** : `/` (racine)
   - Déploie. Tu obtiens une URL `…pages.dev`.
3. **Important** — retourne dans Supabase → **Authentication → URL Configuration** et règle le **Site URL** sur ton URL `…pages.dev` (et ajoute-la aux *Redirect URLs*). Ça évite les soucis de connexion/email.

Désormais, chaque `git push` (depuis VS Code + Claude) redéploie le site automatiquement.

## Étape 8 — Inviter les créateurs

1. Partage l'URL de la plateforme à tes créateurs.
2. Chacun clique **Créer un compte**, choisit email + mot de passe, dépose ses vidéos.
3. Dans ta console → onglet **Créateurs**, tu vois les nouveaux « en attente » : clique **Activer** et règle leur barème. Ils peuvent alors travailler, et tu vois leurs données en direct.

## Étape 9 *(optionnel)* — Relevé YouTube automatique

1. Dans Google Cloud Console : crée une clé API, active **YouTube Data API v3**, restreins la clé.
2. Dans la console maître → **Réglages → Connecteur YouTube**, colle la clé.
3. Onglet **Déclarations** → bouton **Relever YouTube (auto)** : les vues YouTube sont récupérées et validées automatiquement. (La clé reste sur ton appareil, elle n'est pas envoyée à la base.)

---

## Modifier la plateforme plus tard (VS Code + Claude)

Ouvre le dossier dans VS Code, lance Claude dedans, demande tes évolutions. Les fichiers à connaître :

- `app.js` — toute la logique et l'affichage.
- `styles.css` — le design.
- `supabase/schema.sql` — la base, la sécurité (RLS) et les fonctions. Toute modif de structure se relance dans le SQL Editor de Supabase.
- `config.js` — les clés de connexion.

Un `git push` redéploie. La base, elle, se modifie côté Supabase.

---

## Sécurité, en clair

- La clé **anon** est publique ; les données sont protégées par les politiques **RLS** du schéma (un créateur ne voit que ses propres vidéos et relevés ; l'admin voit tout).
- Les opérations sensibles (déclarer, valider, payer) passent par des **fonctions serveur** (`declare_views`, `validate_reading`, `mark_creator_paid`) qui vérifient les droits. Un créateur ne peut ni valider ni marquer payé.
- Ne committe **jamais** la clé `service_role`.

## Limites connues / à vérifier

- **Offre gratuite Supabase** : largement suffisante pour ~15 créateurs. Vérifie sur leur page de tarifs les conditions à jour (taille de base, utilisateurs actifs) ; les projets gratuits inactifs peuvent se mettre en pause après une période sans activité — il suffit de les réactiver.
- **Rappels automatiques par email** : non inclus (le site est statique). Possibles plus tard via une fonction planifiée (Supabase Edge Function + cron) — à cadrer avec un dev. En attendant, la console te donne la liste de relance + un message prêt à copier.
- **Vues Instagram / TikTok** : pas de relevé automatique sans backend dédié (connexion OAuth du compte créateur ou API tierce payante). En attendant, le créateur déclare ses vues pendant la fenêtre.
- Cette version n'a pas été testée contre une instance Supabase réelle lors de sa génération : prévois une courte passe de mise au point (les messages d'erreur Supabase s'affichent en bas de l'écran), idéalement avec Claude dans VS Code.
