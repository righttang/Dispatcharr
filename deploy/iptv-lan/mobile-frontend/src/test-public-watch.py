import json
import os
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from django.test import RequestFactory, SimpleTestCase
from rest_framework.test import APIRequestFactory

from apps.channels import public_watch
from apps.channels.api_views import ChannelViewSet


class PublicWatchTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()
        enabled = patch.dict(os.environ, {"DISPATCHARR_PUBLIC_WATCH": "1"})
        enabled.start()
        self.addCleanup(enabled.stop)
        gate = patch.object(public_watch, "network_access_allowed", return_value=True)
        self.gate = gate.start()
        self.addCleanup(gate.stop)

    def test_catalog_exposes_only_viewer_fields_and_respects_channel_overrides(self):
        channel = SimpleNamespace(
            id=4, uuid=uuid4(), effective_name="Pinned channel", effective_channel_number=13,
            effective_channel_group_id=2, effective_channel_group_obj=SimpleNamespace(id=2, name="News"),
            effective_stream_profile_obj=SimpleNamespace(name="Private profile", parameters="private-command"),
            url="https://private-provider.invalid/secret", custom_properties={"password": "private"},
        )
        with patch.object(public_watch.Channel, "objects") as manager, patch.object(public_watch.OutputProfile, "objects") as outputs:
            manager.with_effective_values.return_value.filter.return_value.select_related.return_value.distinct.return_value = [channel]
            outputs.filter.return_value.values_list.return_value.first.return_value = 3
            response = public_watch.channel_catalog(self.factory.get("/api/watch/channels/"))
            manager.with_effective_values.return_value.filter.assert_called_once_with(
                hidden_from_output=False, effective_is_radio=False, streams__isnull=False
            )
        payload = json.loads(response.content)
        self.assertEqual(payload["channels"][0], {
            "id": 4, "uuid": str(channel.uuid), "name": "Pinned channel", "channel_number": 13,
            "channel_group_id": 2, "native_output_profile_id": 3,
        })
        self.assertEqual(payload["groups"], {"2": {"id": 2, "name": "News"}})
        self.assertNotIn("private", response.content.decode())
        self.assertEqual(response["Cache-Control"], "no-store")

    def test_catalog_can_be_disabled_without_reading_channel_data(self):
        with patch.dict(os.environ, {"DISPATCHARR_PUBLIC_WATCH": "0"}), patch.object(public_watch.Channel, "objects") as manager:
            response = public_watch.channel_catalog(self.factory.get("/api/watch/channels/"))
        self.assertFalse(json.loads(response.content)["enabled"])
        manager.with_effective_values.assert_not_called()

    def test_network_policy_still_applies_to_public_viewing(self):
        self.gate.return_value = False
        response = public_watch.channel_catalog(self.factory.get("/api/watch/channels/"))
        self.assertEqual(response.status_code, 403)

    def test_public_catalog_does_not_accept_writes(self):
        response = public_watch.channel_catalog(self.factory.post("/api/watch/channels/"))
        self.assertEqual(response.status_code, 405)

    def test_anonymous_hls_viewer_can_stop_only_the_bound_client(self):
        session = {"user_id": "0", "channel_id": "channel", "client_id": "own-client"}
        with patch.object(public_watch.RedisClient, "get_client"), patch.object(public_watch, "get_hls_session", return_value=session), patch.object(public_watch.ChannelService, "stop_client") as stop:
            response = public_watch.destroy_anonymous_session(self.factory.delete("/api/watch/sessions/token/"), "token")
        self.assertEqual(response.status_code, 204)
        stop.assert_called_once_with("channel", "own-client")

    def test_public_cleanup_cannot_stop_authenticated_or_missing_sessions(self):
        for session in (None, {"user_id": "9", "channel_id": "channel", "client_id": "other"}, {"channel_id": "channel", "client_id": "unknown-owner"}):
            with self.subTest(session=session), patch.object(public_watch.RedisClient, "get_client"), patch.object(public_watch, "get_hls_session", return_value=session), patch.object(public_watch.ChannelService, "stop_client") as stop:
                response = public_watch.destroy_anonymous_session(self.factory.delete("/api/watch/sessions/token/"), "token")
                self.assertEqual(response.status_code, 404)
                stop.assert_not_called()

    def test_cleanup_obeys_network_and_feature_settings(self):
        request = self.factory.delete("/api/watch/sessions/token/")
        with patch.object(public_watch.ChannelService, "stop_client") as stop:
            self.gate.return_value = False
            self.assertEqual(public_watch.destroy_anonymous_session(request, "token").status_code, 403)
            with patch.dict(os.environ, {"DISPATCHARR_PUBLIC_WATCH": "0"}):
                self.assertEqual(public_watch.destroy_anonymous_session(request, "token").status_code, 404)
            stop.assert_not_called()

    def test_channel_management_writes_still_require_authentication(self):
        factory = APIRequestFactory()
        with patch("apps.accounts.permissions.network_access_allowed", return_value=True):
            for method, action in (("post", "create"), ("patch", "partial_update"), ("delete", "destroy")):
                with self.subTest(action=action):
                    request = getattr(factory, method)("/api/channels/channels/", {}, format="json")
                    response = ChannelViewSet.as_view({method: action})(request, pk=1)
                    self.assertIn(response.status_code, (401, 403))
