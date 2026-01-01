#!/bin/sh
# Run on dev-01 as root. Only creates this account's certificate and key.
set -eu
[ "$(id -u)" -eq 0 ] || { echo 'Run this script as root on dev-01.' >&2; exit 1; }
[ "$#" -eq 2 ] || { echo 'Usage: mail-add-account.sh id address' >&2; exit 1; }
mail_id=$1
mail_address=$2
case "$mail_id" in ''|*[!a-z0-9_-]*|[!a-z]*) echo 'Use a lowercase account id beginning with a letter.' >&2; exit 1;; esac
[ "${#mail_id}" -le 40 ] || exit 1
printf '%s\n' "$mail_address" | LC_ALL=C awk 'BEGIN{ok=0} /^[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/ {ok=1} END{exit !ok}' || { echo 'Use a plain email address.' >&2; exit 1; }
mail_dir=/etc/mastan-me/mail
mail_key="$mail_dir/$mail_id.key"
mail_cert="$mail_dir/$mail_id.crt"
if [ -e "$mail_key" ] || [ -e "$mail_cert" ]; then
  [ -f "$mail_key" ] && [ -f "$mail_cert" ] || { echo 'Only one account file exists. Resolve that first; nothing was changed.' >&2; exit 1; }
else
  install -d -m 0750 -o root -g mastan "$mail_dir"
  umask 077
  mail_tmp=$(mktemp -d "$mail_dir/.new-XXXXXX")
  trap 'rm -rf "$mail_tmp"' EXIT HUP INT TERM
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 -subj "/CN=mastan-me-$mail_id" -keyout "$mail_tmp/key" -out "$mail_tmp/cert"
  install -m 0640 -o root -g mastan "$mail_tmp/key" "$mail_key"
  install -m 0644 -o root -g mastan "$mail_tmp/cert" "$mail_cert"
fi
cat "$mail_cert"
printf '\nCopy the certificate above to cert.pem on the mail server, then run:\ncd /opt/mox && ./mox config tlspubkey add %s mastan-me-%s < cert.pem\n' "$mail_address" "$mail_id"
printf '\nAdd this entry to /var/lib/mastan-me/config/mail-accounts.json, then restart mastan-me:\n'
printf '{"id":"%s","label":"%s","host":"mail.example.com","imapPort":993,"smtpPort":465,"certFile":"%s","keyFile":"%s","addresses":[{"address":"%s","name":"Mastan"}],"alerts":false}\n' "$mail_id" "$mail_id" "$mail_cert" "$mail_key" "$mail_address"
