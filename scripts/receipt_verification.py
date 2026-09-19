#!/usr/bin/env python3
"""Read-only Astra queue selection and saved review verification; never claims work."""
import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
from urllib.parse import urlencode

from receipt_api import ClientError, ScannerClient, credentials


def require(condition, message):
    if not condition:
        raise ClientError(message)


def queue(client, limit=10):
    ready, jev_seen, jev_cursor = set(), set(), None
    while True:
        query = {'limit': 25}
        if jev_cursor:
            query['after'] = jev_cursor
        jev = client.get('/api/jev/documents?' + urlencode(query))
        ready.update(
            item['document_id'] for item in jev.get('documents', [])
            if item.get('ready') is True and (item.get('jev') or {}).get('role') == 'purchase_document'
        )
        jev_cursor = jev.get('next')
        if not jev_cursor:
            break
        require(jev_cursor not in jev_seen, 'Repeated Jev cursor; review inventory is incomplete.')
        jev_seen.add(jev_cursor)
    selected, seen, cursor = {}, set(), None
    while True:
        query = dict(summary=1, limit=100)
        if cursor:
            query['after'] = cursor
        page = client.get('/api/documents?' + urlencode(query))
        for document in page['documents']:
            processing = document.get('processing') or {}
            if (document.get('id') in ready
                    and processing.get('small_model_certainty') in {'low', 'medium'}
                    and processing.get('large_model_confidence') is None
                    and not processing.get('has_human_review') and not document.get('duplicateOf')
                    and document.get('pageIds') and processing.get('disposition') != 'processing'):
                selected[document['id']] = dict(document_id=document['id'], revision=document['revision'],
                    confidence=processing['small_model_certainty'], page_count=len(document['pageIds']),
                    scanned_at=min(document.get('scannedAt') or ['']))
        cursor = page.get('next')
        if not cursor:
            break
        require(cursor not in seen, 'Repeated summary cursor; review inventory is incomplete.')
        seen.add(cursor)
    ordered = sorted(selected.values(), key=lambda item: (item['scanned_at'], item['document_id']))
    return dict(origin=client.origin, eligible=len(ordered), documents=ordered[:limit])


def verify(client, work, expected_id, expected_revision):
    def load(name):
        return json.loads((work / name).read_text(encoding='utf-8'))
    claim = load('claim-response.json')['claim']
    require(claim['stage'] == 'large', 'Expected an Astra large-stage claim.')
    document_id = claim['document']['id']
    require(document_id == expected_id and claim['document']['revision'] == expected_revision,
            'Worker reviewed a different target than the coordinator assigned.')
    require(load('claim-request.json') == dict(stage='large', document_id=expected_id, revision=expected_revision),
            'Expected a targeted claim for the assigned document and revision.')
    draft = load('draft-request.json')
    request = load('submit-request.json')
    require(all(item['model'] == 'gpt-6-astra' and item['token'] == claim['token'] for item in (draft, request)),
            'Astra checkpoint and submission must belong to this exact claim.')
    require(load('draft-response.json').get('saved') is True, 'Independent checkpoint was not acknowledged.')
    require(draft['extraction'] == load('astra-draft-extraction.json'), 'Independent draft file differs from its request.')
    require(request['extraction'] == load('astra-reconciled-extraction.json'), 'Reconciled file differs from its submission.')
    context = load('context-response.json')
    require(context['document']['id'] == document_id and context['document']['revision'] == claim['document']['revision']
            and context['independent_parse'] == draft['extraction'], 'Server draft readback differs from the independent reading.')
    submitted = [item for item in load('submit-response.json')['saved'] if item['id'] == document_id]
    require(len(submitted) == 1, 'Submission did not acknowledge this document exactly once.')
    require(submitted[0]['revision'] == expected_revision + 1, 'Submission revision does not follow the claimed revision.')
    checkpoint = client.get('/api/processing/readings?' + urlencode(dict(document_id=document_id, checkpoint_token=claim['token'])))
    require(checkpoint.get('draft_saved') is True and checkpoint.get('attempt_saved') is True
            and checkpoint.get('claim_active') is False, 'Astra draft, saved attempt and closed claim are required.')
    final = client.get('/api/documents/' + document_id)['document']
    recorded = load('final-document.json')
    require(final['id'] == recorded['id'] == document_id and final['revision'] == recorded['revision']
            and final['pages'] == recorded['pages'], 'Document changed after the recorded verification.')
    intended = deepcopy(claim['document']['pages'])
    if 'documents' in request:
        targets = [item for item in request['documents'] if item['id'] == document_id]
        require(len(targets) == 1, 'Submitted grouping must identify the retained document.')
        intended = deepcopy(targets[0]['pages'])
    if len(intended) == 1:
        intended[0]['type'] = request['extraction']['type']
    require(final['pages'] == intended, 'Saved page membership/order/layout differs from the submission.')
    confidence = final['processing']['large_model_confidence']
    require(confidence in {'low', 'medium', 'high'}, 'Saved Astra confidence is missing.')
    saved, proposed = final['processing']['extraction'], request['extraction']
    adjusted = {'certainty', 'uncertainties', 'broken_reasons'}
    require(set(saved) == set(proposed) and all(saved[key] == value for key, value in proposed.items() if key not in adjusted),
            'Live saved extraction differs from the submitted Astra values.')
    rank = {'low': 0, 'medium': 1, 'high': 2}
    require(saved['certainty'] == confidence and rank[confidence] <= rank[proposed['certainty']],
            'Saved confidence is not a supported server cap.')
    require(all(set(proposed[key]) <= set(saved[key]) for key in ('uncertainties', 'broken_reasons')),
            'Saved review reasons lost a submitted uncertainty.')
    applicable = bool(final.get('filename') and not final.get('mergedInto') and not final.get('duplicateOf'))
    require(final['revision'] == submitted[0]['revision'] + int(applicable), 'Unexpected post-submit revision.')
    if applicable:
        pdf = load('pdf-result.json')
        review = load('pdf-review-request.json')
        require(final['checks']['pdf'] is True and pdf['sha256'] == final['pdf']['sha256']
                == final['reviewedPdfSha256'] == review['sha256'], 'PDF hash/attestation mismatch.')
        require(review['document_id'] == document_id and review['revision'] == submitted[0]['revision']
                == pdf['revision'] == final['pdf']['revision']
                and isinstance(review.get('evidence'), str) and 0 < len(review['evidence'].strip()) <= 2000,
                'PDF review must identify this revision and record the actual visual inspection.')
        require(hashlib.sha256(Path(pdf['path']).read_bytes()).hexdigest() == pdf['sha256']
                and pdf['pages'] == len(final['pages']), 'Local PDF differs from the attested document.')
    return dict(verified=True, document_id=document_id, revision=final['revision'], confidence=confidence,
                status=final['status'], page_count=len(final['pages']), claim_closed=True, pdf_applicable=applicable)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    commands = parser.add_subparsers(dest='command', required=True)
    listing = commands.add_parser('queue')
    listing.add_argument('--limit', type=int, default=10)
    proof = commands.add_parser('verify')
    proof.add_argument('work_directory', type=Path)
    proof.add_argument('--document-id', required=True)
    proof.add_argument('--revision', required=True, type=int)
    args = parser.parse_args()
    if args.command == 'queue' and not 1 <= args.limit <= 1000:
        parser.error('--limit must be between 1 and 1000')
    client = ScannerClient(credentials(args.config))
    print(json.dumps(queue(client, args.limit) if args.command == 'queue' else
                     verify(client, args.work_directory, args.document_id, args.revision)))


if __name__ == '__main__':
    main()
