// Why a visitor can't use the admin controls, from /admin/status. A null user
// means no login reached the app at all (the ingress didn't pass
// X-Auth-Request-User on), which is a deployment fault rather than a missing
// admin_for entry, so the two read differently.
export function AdminAccessNote({
  user,
  consequence,
}: {
  user: string | null;
  consequence: string;
}) {
  return (
    <p className="admin-locked" role="note">
      {user === null
        ? `No login reached the app, so ${consequence}. The deployment isn't passing logins through; tell whoever runs it.`
        : `Signed in as ${user}, who isn't an admin for this site, so ${consequence}.`}
    </p>
  );
}
