from backend.app.services.audit_service import AuditService
from backend.app.services.forensic_service import ForensicService
from backend.app.services.statutory_service import StatutoryService


def test_gstin_validation() -> None:
    service = StatutoryService()
    result = service.validate_gstin('27ABCDE1234F1Z5')
    assert result.is_valid
    assert result.pan == 'ABCDE1234F'


def test_gstin_missing_data() -> None:
    service = StatutoryService()
    result = service.validate_gstin(None)
    assert not result.is_valid
    assert 'Data Missing' in result.alerts[0]


def test_control_coverage_count() -> None:
    audit_service = AuditService(ForensicService(), StatutoryService())
    checks, _ = audit_service.run_checks(
        filename='sample.pdf',
        file_bytes=b'%PDF-1.4 fake',
        gstin=None,
        hsn_or_sac=None,
        claimed_tax_rate=None,
    )
    assert len(checks) == 26
    ids = {check.check_id for check in checks}
    assert '1.1' in ids and '5.5' in ids
